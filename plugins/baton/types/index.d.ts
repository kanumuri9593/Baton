/** One Baton run as the band and the panel draw it. */
export type Run = {
  id: string
  name: string
  kind: string
  status: 'starting' | 'running' | 'stopped' | 'failed'
  /** Project folder name. */
  project: string
  /** Simulator, emulator or device name, when the run is on one. */
  device?: string
  url?: string
  progress?: string
  cpuPct?: number
  rssBytes?: number
  capabilities: string[]
}

/** The last screenshot taken from the panel. */
export type Shot = { runId: string; path: string; at: number; svg?: string }

declare module 'claude-code' {
  interface PluginState {
    baton: {
      runs: Run[]
      isOnline: boolean
      busy: string | null
      shot: Shot | null
      isBandHidden: boolean
    }
  }
}
