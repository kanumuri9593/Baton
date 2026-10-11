// Pause, resume and bring to front: controls the daemon has no method for.
// The same rules as the MCP card's (src/mcp/controls.ts), kept free of Node so
// the mod can run them through `$.process.run`. Whether a run is paused is read
// back from `ps` (a stopped process shows `T`), so the band, the panel and the
// card always agree. macOS only; Android runs are left alone.

export type ControlRun = { id: string; kind: string; status: string; target?: string; url?: string; pid?: number }
export type Proc = { pid: number; ppid: number; stat: string; command: string }

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i

export const isSimulator = (r: ControlRun) => !!r.target && UDID.test(r.target) && r.kind !== 'android'
export const canPause = (r: ControlRun, mac: boolean) => mac && r.kind !== 'android' && (isSimulator(r) || r.pid != null)
export const canFront = (r: ControlRun, mac: boolean) => mac && (isSimulator(r) || !!r.url)

export function parsePs(out: string): Proc[] {
  return out.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3]!, command: m[4]! }] : []
  })
}

/** The processes that are "the app": the installed app on that simulator, or the run's process tree. */
export function appProcesses(r: ControlRun, procs: Proc[]): Proc[] {
  if (isSimulator(r)) {
    const marker = `/Devices/${r.target}/data/Containers/Bundle/Application/`
    return procs.filter(p => p.command.includes(marker))
  }
  if (r.pid == null) return []
  const tree = new Set([r.pid])
  for (let grew = true; grew;) {
    grew = false
    for (const p of procs) {
      if (!tree.has(p.pid) && tree.has(p.ppid)) {
        tree.add(p.pid)
        grew = true
      }
    }
  }
  return procs.filter(p => tree.has(p.pid))
}

export function pausedIds(runs: ControlRun[], procs: Proc[], mac: boolean): string[] {
  return runs
    .filter(r => r.status === 'running' && canPause(r, mac))
    .filter(r => {
      const app = appProcesses(r, procs)
      return app.length > 0 && app.every(p => p.stat.startsWith('T'))
    })
    .map(r => r.id)
}

/** The command that brings a run's window forward. */
export const frontCommand = (r: ControlRun): string[] => (isSimulator(r) ? ['open', '-a', 'Simulator'] : ['open', r.url!])
