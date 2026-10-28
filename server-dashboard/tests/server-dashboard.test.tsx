import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'server-dashboard',
  component: 'Pane',
  requestId: 'server-dashboard',
  props: {
    title: 'Server',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SNAPSHOT = {
  host: 'ip-172-31-40-76',
  uptime: '3 days, 2 hours',
  load: '0.12 0.20 0.18',
  cpus: 2,
  memUsed: 1_000_000_000,
  memTotal: 4_000_000_000,
  diskUsed: 19_000_000_000,
  diskTotal: 20_000_000_000,
  commit: 'a1b2c3d Fix login (2 hours ago)',
  isDirty: false,
  health: { status: 200, ms: 42 },
  at: 0,
}

test('the guard blocks dangerous commands and lets others run', async ($, on) => {
  on('tool.call', () => ({ result: {} }))

  for (const command of ['sudo rm -rf /', 'sudo reboot', 'git push --force origin main', 'psql -c "DROP TABLE users"', 'aws ec2 terminate-instances --instance-ids i-1']) {
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(ran.deny ?? (ran as { text?: string }).text).toMatch(/blocked/)
  }

  for (const command of ['ls -la', 'git pull --ff-only', 'sudo systemctl restart myapp', 'rm -rf node_modules']) {
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(ran.deny).toBeUndefined()
  }
})

test('the pane shows health on phone and desktop', async ($, on) => {
  on('clock.now', () => ({ value: 60_000 }))
  on('state.get', (_, e) => ({
    value: (e as { key: string }).key === 'snapshot' ? { value: { shape: 'snapshot-1', value: SNAPSHOT }, version: 1 } : { value: { shape: 'deploys-1', value: [{ kind: 'deploy', at: 0, fromCommit: '9f8e7d6' }] }, version: 1 },
  }))

  for (const surface of ['mobile', 'desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /ip-172-31-40-76/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /UP · HTTP 200/ }))?.text).toContain('42ms')
    expect((await ui.find({ type: 'Text', text: /95%/ }))?.text).toBeDefined()
    expect(await ui.find({ key: 'deploy' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /from 9f8e7d6/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/server prints the dashboard as text for the phone', async ($, on) => {
  on('command.register', () => ({ value: { command: 'server' } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('clock.now', () => ({ value: 60_000 }))
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv.join(' ')
    const out: Record<string, string> = {
      hostname: 'ip-172-31-40-76',
      'uptime -p': 'up 3 days',
      'cat /proc/loadavg': '0.12 0.20 0.18 1/100 1',
      nproc: '2',
      'free -b': '              total        used\nMem:     4000000000  1000000000',
      'df -B1 --output=used,size /': ' Used Size\n19000000000 20000000000',
    }
    return { value: { exitCode: argv in out ? 0 : 1, stdout: out[argv] ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const ran = await $.command.run({ command: 'server', args: '' })
  expect(ran.text).toContain('ip-172-31-40-76 · up 3 days')
  expect(ran.text).toContain('Disk    ███████████░ 95%')
})
