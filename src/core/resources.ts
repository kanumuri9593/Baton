/**
 * Cheap OS samples for live session pids.
 *
 * One `ps -p` for the pids we already know — not a profiler, not a process-tree
 * walk. RSS in `ps` is kilobytes on macOS and Linux; we convert once so every
 * surface speaks bytes. Windows has no sampler: callers get an empty map and
 * omit the numbers.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionSnapshot } from './types.ts';

const execFileDefault = promisify(execFileCb);

export type ProcessSample = { pid: number; cpuPct: number; rssBytes: number };

export type ProcessSampler = {
  execFile: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
};

const defaultSampler: ProcessSampler = {
  async execFile(file, args) {
    const { stdout, stderr } = await execFileDefault(file, args, {
      encoding: 'utf8',
      timeout: 1500,
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  },
};

/** Parse `ps -o pid=,pcpu=,rss=` stdout into a map keyed by pid. */
export function parsePs(stdout: string): Map<number, ProcessSample> {
  const samples = new Map<number, ProcessSample>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const cpuPct = Number(match[2]);
    const rssKb = Number(match[3]);
    samples.set(pid, { pid, cpuPct, rssBytes: rssKb * 1024 });
  }
  return samples;
}

/**
 * Sample RSS and CPU for specific pids.
 *
 * Duplicate pids are collapsed. An empty list, a `ps` failure, or a platform
 * with no `ps` all return an empty map — callers treat missing numbers as
 * "don't show", not as an error.
 */
export async function samplePids(
  pids: number[],
  sampler: ProcessSampler = defaultSampler,
): Promise<Map<number, ProcessSample>> {
  const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (unique.length === 0) return new Map();
  if (process.platform === 'win32' && sampler === defaultSampler) return new Map();
  try {
    const { stdout } = await sampler.execFile('ps', ['-o', 'pid=,pcpu=,rss=', '-p', unique.join(',')]);
    return parsePs(stdout);
  } catch {
    return new Map();
  }
}

/** Copy rss/cpu onto snapshots whose pid appears in the sample map. */
export function overlayResources(
  snapshots: SessionSnapshot[],
  samples: Map<number, ProcessSample>,
): SessionSnapshot[] {
  return snapshots.map((snapshot) => {
    if (snapshot.pid == null) return snapshot;
    const sample = samples.get(snapshot.pid);
    if (!sample) return snapshot;
    return { ...snapshot, rssBytes: sample.rssBytes, cpuPct: sample.cpuPct };
  });
}
