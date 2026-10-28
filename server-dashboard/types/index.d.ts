export type Snapshot = {
  host: string
  uptime: string
  load: string
  cpus: number
  memUsed: number
  memTotal: number
  diskUsed: number
  diskTotal: number
  commit: string | null
  isDirty: boolean
  health: { status: number | null; ms: number } | null
  at: number
}

export type Deploy = { kind: 'deploy' | 'rollback'; at: number; fromCommit: string | null }

declare module 'claude-code' {
  interface PluginState {
    'server-dashboard': {
      snapshot: Shaped<Snapshot | null>
      deploys: Shaped<Deploy[]>
    }
  }
}
