import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Deploy, Snapshot } from '../types'

const PANE = 'server-dashboard'
const REFRESH_MS = 30_000
// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const snapshot = atom({ plugin: 'server-dashboard', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
const deploys = atom({ plugin: 'server-dashboard', key: 'deploys' } as const, [], {
  shape: 'deploys-1',
})

// Commands Claude is never allowed to run on a server, whatever it is asked.
const BLOCKED: ReadonlyArray<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|\/\*)(\s|$)/i, 'deleting / or the home folder'],
  [/\b(shutdown|reboot|halt|poweroff)\b/, 'shutting down or rebooting the server'],
  [/\bmkfs(\.\w+)?\b/, 'formatting a disk'],
  [/\bdd\b[^|;&]*\bof=\/dev\//, 'writing straight to a disk device'],
  [/>\s*\/dev\/(sd|nvme|xvd)/, 'writing straight to a disk device'],
  [/\bgit\s+push\b[^|;&]*(\s--force\b|\s-f\b)/, 'force-pushing'],
  [/\bdrop\s+(table|database|schema)\b/i, 'dropping database objects'],
  [/\btruncate\s+table\b/i, 'truncating a table'],
  [/\bchmod\s+-R\s+0?777\s+\/(\s|$)/, 'opening permissions on the whole disk'],
  [/:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, 'a fork bomb'],
  [/\baws\b[^|;&]*\s(delete|terminate|remove|deregister)[-\w]*/, 'deleting or terminating AWS resources'],
]

type Options = { appDir: string; restartCommand: string; healthUrl: string }

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

async function sh($: EngineInterface, argv: string[], cwd?: string): Promise<string> {
  try {
    const { exitCode, stdout } = await $.process.run(argv, { cwd, timeoutMs: 10_000 })

    return exitCode === 0 ? stdout.trim() : ''
  } catch {
    return ''
  }
}

async function collect($: EngineInterface, options: Options): Promise<Snapshot> {
  const [host, uptime, loadavg, cpus, free, df] = await Promise.all([
    sh($, ['hostname']),
    sh($, ['uptime', '-p']),
    sh($, ['cat', '/proc/loadavg']),
    sh($, ['nproc']),
    sh($, ['free', '-b']),
    sh($, ['df', '-B1', '--output=used,size', '/']),
  ])
  const mem = (free.split('\n').find(line => line.startsWith('Mem:')) ?? '').split(/\s+/)
  const disk = (df.split('\n')[1] ?? '').trim().split(/\s+/)

  let commit: string | null = null
  let isDirty = false
  if (options.appDir !== '') {
    commit = (await sh($, ['git', '-C', options.appDir, 'log', '-1', '--format=%h %s (%cr)'])) || null
    isDirty = (await sh($, ['git', '-C', options.appDir, 'status', '--porcelain'])) !== ''
  }

  let health: Snapshot['health'] = null
  if (options.healthUrl !== '') {
    const startedAt = await $.clock.now()
    let status: number | null = null
    try {
      status = (await $.http.fetch(options.healthUrl)).status
    } catch {
      status = null
    }
    health = { status, ms: (await $.clock.now()) - startedAt }
  }

  return {
    host: host || 'unknown host',
    uptime: uptime.replace(/^up\s+/, ''),
    load: loadavg.split(' ').slice(0, 3).join(' '),
    cpus: Number(cpus) || 1,
    memUsed: Number(mem[2]) || 0,
    memTotal: Number(mem[1]) || 0,
    diskUsed: Number(disk[0]) || 0,
    diskTotal: Number(disk[1]) || 0,
    commit,
    isDirty,
    health,
    at: await $.clock.now(),
  }
}

function bar(used: number, total: number): string {
  const share = total > 0 ? Math.min(1, used / total) : 0
  const filled = Math.round(share * 12)

  return `${'█'.repeat(filled)}${'░'.repeat(12 - filled)} ${Math.round(share * 100)}%`
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function level(used: number, total: number): 'success' | 'warning' | 'error' {
  const share = total > 0 ? used / total : 0

  return share >= 0.9 ? 'error' : share >= 0.75 ? 'warning' : 'success'
}

function ago(now: number, at: number): string {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`

  return `${Math.round(minutes / 60 / 24)}d ago`
}

// The dashboard as plain text, for surfaces that do not draw the pane (the
// phone app) and for the model, which reads a command's output too.
function report(now: Snapshot | null, history: Deploy[], options: Options, clock: number): string {
  if (now === null) return 'Could not read server health.'

  const health = now.health
  const lines = [
    `${now.host} · up ${now.uptime}`,
    `Load    ${now.load} (${now.cpus} CPU)`,
    `Memory  ${bar(now.memUsed, now.memTotal)}  ${gb(now.memUsed)} / ${gb(now.memTotal)}`,
    `Disk    ${bar(now.diskUsed, now.diskTotal)}  ${gb(now.diskUsed)} / ${gb(now.diskTotal)}`,
    options.appDir === ''
      ? 'App     (set the app folder in /config)'
      : `App     ${now.commit ?? 'not a git repo'}${now.isDirty ? ' · uncommitted changes' : ''}`,
  ]
  if (health !== null) {
    lines.push(
      health.status !== null && health.status < 400
        ? `Health  UP · HTTP ${health.status} · ${health.ms}ms`
        : `Health  DOWN · ${health.status === null ? 'no answer' : `HTTP ${health.status}`}`,
    )
  }
  for (const one of history.slice(0, 3)) {
    lines.push(`${one.kind === 'deploy' ? 'Deploy ' : 'Rollback'} ${ago(clock, one.at)}${one.fromCommit ? ` · from ${one.fromCommit}` : ''}`)
  }
  lines.push('', '/deploy · /rollback · /health')

  return lines.join('\n')
}

function deployPrompt(options: Options): string {
  const where = options.appDir || '(not set: find the app on this server and confirm it with me first)'
  const restart = options.restartCommand || '(not set: work out how the app is restarted and confirm it with me first)'
  const check = options.healthUrl || '(not set: check the service status and recent logs instead)'

  return [
    'Deploy the app on this server.',
    `App folder: ${where}`,
    `Restart command: ${restart}`,
    `Health check: ${check}`,
    '',
    'Steps:',
    '1. Note the current commit (git rev-parse --short HEAD) so we can roll back.',
    '2. If there are uncommitted changes, stop and tell me.',
    '3. git pull --ff-only.',
    '4. If dependency or build files changed, install and build.',
    '5. Restart the app with the restart command.',
    '6. Verify it is up (health check, service status, last 30 log lines).',
    '7. Report: commit before -> after, what changed, and whether it is healthy.',
    'If anything fails, show me the error and ask before rolling back.',
  ].join('\n')
}

function rollbackPrompt(options: Options, toCommit: string | null): string {
  return [
    'Roll back the app on this server.',
    `App folder: ${options.appDir || '(not set: find the app and confirm it with me first)'}`,
    `Restart command: ${options.restartCommand || '(not set: confirm with me first)'}`,
    toCommit
      ? `Roll back to commit ${toCommit} (the commit before the last deploy).`
      : 'Show me the last 5 commits and ask which one to roll back to.',
    'Show me what will change and ask me to confirm before resetting. Then restart, verify it is healthy, and report.',
  ].join('\n')
}

async function refresh($: EngineInterface, options: Options) {
  const next = await collect($, options)
  await update($, snapshot, () => next)
}

async function record($: EngineInterface, kind: Deploy['kind']) {
  const current = await read($, snapshot)
  const entry: Deploy = { kind, at: await $.clock.now(), fromCommit: current?.commit?.split(' ')[0] ?? null }
  await update($, deploys, list => [entry, ...list].slice(0, 20))
  await $.store.set('deploys', await read($, deploys))
}

async function deploy($: EngineInterface, options: Options) {
  await record($, 'deploy')
  await $.prompt.submit({ text: deployPrompt(options) })
}

async function rollback($: EngineInterface, options: Options) {
  const last = (await read($, deploys)).find(one => one.kind === 'deploy')
  await record($, 'rollback')
  await $.prompt.submit({ text: rollbackPrompt(options, last?.fromCommit ?? null) })
}

export const register: Register = (on, rawOptions) => {
  const options: Options = {
    appDir: text(rawOptions.appDir),
    restartCommand: text(rawOptions.restartCommand),
    healthUrl: text(rawOptions.healthUrl),
  }

  on('session.start', async ($, e, next) => {
    for (const [name, description] of [
      ['server', 'Open the server dashboard pane'],
      ['deploy', 'git pull, rebuild, restart and verify the app (asks before risky steps)'],
      ['rollback', 'Roll the app back to the commit before the last deploy'],
      ['health', 'Refresh server and app health now'],
    ] as const) {
      await $.command.register({ name, description })
    }

    const saved = await $.store.get('deploys')
    if (Array.isArray(saved)) {
      await update($, deploys, () => saved as Deploy[])
    }

    void refresh($, options)
    $.clock.every(REFRESH_MS, () => void refresh($, options))
    void $.ui.open({ id: PANE, title: 'Server' })

    return next(e)
  })

  on('command.run', { command: 'server' }, async $ => {
    await refresh($, options)
    void $.ui.open({ id: PANE, title: 'Server' })

    return { text: report(await read($, snapshot), await read($, deploys), options, await $.clock.now()) }
  })

  on('command.run', { command: 'health' }, async $ => {
    await refresh($, options)

    return { text: report(await read($, snapshot), [], options, await $.clock.now()) }
  })

  on('command.run', { command: 'deploy' }, async $ => {
    await deploy($, options)

    return { text: 'Deploy started.' }
  })

  on('command.run', { command: 'rollback' }, async $ => {
    await rollback($, options)

    return { text: 'Rollback started.' }
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const hit = BLOCKED.find(([pattern]) => pattern.test(e.command))

    return hit
      ? { deny: `server-dashboard blocked this command (${hit[1]}). Ask the person to run it themselves if it is really needed.` }
      : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'server-dashboard: its safety check failed, so the command was blocked.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await read($, snapshot)
    const history = await read($, deploys)
    const clock = await $.clock.now()

    if (now === null) {
      return <Text dimColor>Reading server health…</Text>
    }

    const health = now.health
    const loadShare = Number(now.load.split(' ')[0]) / now.cpus

    return (
      <Box flexDirection="column">
        <Text bold>
          {now.host} <Text dimColor>· up {now.uptime}</Text>
        </Text>
        <Text>
          Load    <Text color={loadShare >= 1 ? 'error' : loadShare >= 0.7 ? 'warning' : 'success'}>{now.load}</Text>
          <Text dimColor> ({now.cpus} CPU)</Text>
        </Text>
        <Text>
          Memory  <Text color={level(now.memUsed, now.memTotal)}>{bar(now.memUsed, now.memTotal)}</Text>
          <Text dimColor> {gb(now.memUsed)} / {gb(now.memTotal)}</Text>
        </Text>
        <Text>
          Disk    <Text color={level(now.diskUsed, now.diskTotal)}>{bar(now.diskUsed, now.diskTotal)}</Text>
          <Text dimColor> {gb(now.diskUsed)} / {gb(now.diskTotal)}</Text>
        </Text>

        <Text> </Text>
        {options.appDir === '' ? (
          <Text dimColor>App: set the app folder in /config to see its status</Text>
        ) : (
          <Text>
            App     {now.commit ?? 'not a git repo'}
            {now.isDirty && <Text color="warning"> · uncommitted changes</Text>}
          </Text>
        )}
        {health !== null && (
          <Text>
            Health  {health.status !== null && health.status < 400 ? (
              <Text color="success">UP · HTTP {health.status} · {health.ms}ms</Text>
            ) : (
              <Text color="error">DOWN · {health.status === null ? 'no answer' : `HTTP ${health.status}`}</Text>
            )}
          </Text>
        )}

        <Text> </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="deploy" variant="primary" onPress={() => void deploy($, options)}>
            Deploy
          </Button>
          <Button key="rollback" onPress={() => void rollback($, options)}>
            Rollback
          </Button>
          <Button key="refresh" onPress={() => void refresh($, options)}>
            Refresh
          </Button>
        </Box>

        {history.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Recent deploys</Text>
            {history.slice(0, 5).map(one => (
              <Text dimColor>
                {one.kind === 'deploy' ? '↑' : '↩'} {one.kind} {ago(clock, one.at)}
                {one.fromCommit ? ` · from ${one.fromCommit}` : ''}
              </Text>
            ))}
          </Box>
        )}
        <Text dimColor>Updated {ago(clock, now.at)} · refreshes every 30s</Text>
      </Box>
    )
  })
}
