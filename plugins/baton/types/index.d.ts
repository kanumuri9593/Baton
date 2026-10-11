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
  /** Its app processes are stopped (SIGSTOP); Resume continues them. */
  paused: boolean
  canPause: boolean
  canFront: boolean
}

/** What New run offers: projects with their targets, and devices to run on or boot. */
export type Catalog = {
  projects: Array<{ root: string; name: string; targets: Array<{ name: string; kind: string }> }>
  devices: Array<{ id: string; name: string; platform: 'ios' | 'android' | 'other'; running: boolean }>
}

/** New run's picks. */
export type Form = { root?: string; target?: string; device?: string; boot?: string }

/** The log pane open in the panel. */
export type Logs = { runId: string; name: string; lines: Array<{ text: string; error: boolean }> }

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
      catalog: Catalog | null
      form: Form
      logs: Logs | null
      /** A Stop all press waiting for its confirm. */
      isStopArmed: boolean
    }
  }
}
