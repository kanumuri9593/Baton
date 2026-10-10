import { execFileSync } from 'node:child_process';
import type { SessionSnapshot } from '../core/types.ts';

/**
 * Card controls the daemon has no method for: pause, resume and bring to front.
 *
 * Stateless on purpose: whether a run is paused is read back from the OS (a
 * stopped process shows `T` in `ps`), so every Claude session's card agrees
 * without the daemon keeping anything. macOS only for now; elsewhere the card
 * hides these buttons.
 */
export type Exec = (command: string, args: string[]) => string;

const defaultExec: Exec = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

type Proc = { pid: number; ppid: number; stat: string; command: string };

export class Controls {
  #exec: Exec;
  #platform: NodeJS.Platform;

  constructor(exec: Exec = defaultExec, platform: NodeJS.Platform = process.platform) {
    this.#exec = exec;
    this.#platform = platform;
  }

  /** A simulator app runs as a macOS process, so pausing it pauses the app itself. */
  isSimulator(s: SessionSnapshot): boolean {
    return !!s.target && UDID.test(s.target) && s.kind !== 'android';
  }

  canPause(s: SessionSnapshot): boolean {
    if (this.#platform !== 'darwin' || s.kind === 'android') return false;
    return this.isSimulator(s) || s.pid != null;
  }

  canFront(s: SessionSnapshot): boolean {
    return this.#platform === 'darwin' && (this.isSimulator(s) || !!s.url);
  }

  #processes(): Proc[] {
    let out = '';
    try {
      out = this.#exec('ps', ['-axo', 'pid=,ppid=,stat=,command=']);
    } catch {
      return [];
    }
    return out.split('\n').flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], command: m[4] }] : [];
    });
  }

  /** The processes that are "the app": the installed app on that simulator, or the run's process tree. */
  #targets(s: SessionSnapshot, procs: Proc[]): Proc[] {
    if (this.isSimulator(s)) {
      const marker = `/Devices/${s.target}/data/Containers/Bundle/Application/`;
      return procs.filter((p) => p.command.includes(marker));
    }
    if (s.pid == null) return [];
    const tree = new Set([s.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const p of procs) {
        if (!tree.has(p.pid) && tree.has(p.ppid)) { tree.add(p.pid); grew = true; }
      }
    }
    return procs.filter((p) => tree.has(p.pid));
  }

  /** Ids of the given runs that are paused right now. */
  pausedIds(sessions: SessionSnapshot[]): Set<string> {
    const paused = new Set<string>();
    const pausable = sessions.filter((s) => s.status === 'running' && this.canPause(s));
    if (pausable.length === 0) return paused;
    const procs = this.#processes();
    for (const s of pausable) {
      const app = this.#targets(s, procs);
      if (app.length > 0 && app.every((p) => p.stat.startsWith('T'))) paused.add(s.id);
    }
    return paused;
  }

  pause(s: SessionSnapshot): void { this.#signal(s, 'STOP'); }
  resume(s: SessionSnapshot): void { this.#signal(s, 'CONT'); }

  #signal(s: SessionSnapshot, signal: 'STOP' | 'CONT'): void {
    if (!this.canPause(s)) throw new Error(`${s.name} can't be paused here`);
    const app = this.#targets(s, this.#processes());
    if (app.length === 0) throw new Error(`${s.name} has no app process to ${signal === 'STOP' ? 'pause' : 'resume'} yet`);
    this.#exec('kill', [`-${signal}`, ...app.map((p) => String(p.pid))]);
  }

  /** Bring the simulator, or the browser on the run's URL, to the front. */
  front(s: SessionSnapshot): void {
    if (!this.canFront(s)) throw new Error(`${s.name} has no window Baton can bring forward`);
    if (this.isSimulator(s)) this.#exec('open', ['-a', 'Simulator']);
    else this.#exec('open', [s.url!]);
  }
}
