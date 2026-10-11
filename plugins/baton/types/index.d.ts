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
  /** Project root and device id, so a finished run can run again. */
  root?: string
  deviceId?: string
  /** Its app processes are stopped (SIGSTOP); Resume continues them. */
  paused: boolean
  canPause: boolean
  canFront: boolean
}

/** The log pane open in the panel. */
export type Logs = { runId: string; name: string; lines: Array<{ text: string; error: boolean }> }

declare module 'claude-code' {
  interface PluginState {
    baton: {
      runs: Run[]
      isOnline: boolean
      busy: string | null
      isBandHidden: boolean
      logs: Logs | null
    }
  }
}
