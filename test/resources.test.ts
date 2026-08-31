import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlayResources, parsePs, samplePids, type ProcessSample } from '../src/core/resources.ts';
import type { SessionSnapshot } from '../src/core/types.ts';

test('parsePs maps pid, cpu percent and rss kilobytes onto bytes', () => {
  const samples = parsePs('  4242  12.5  1024\n  99  0.0   512\n');
  assert.deepEqual(samples.get(4242), { pid: 4242, cpuPct: 12.5, rssBytes: 1024 * 1024 });
  assert.deepEqual(samples.get(99), { pid: 99, cpuPct: 0, rssBytes: 512 * 1024 });
});

test('parsePs ignores blank and unparseable lines', () => {
  const samples = parsePs('\n  not-a-pid  1.0  10\n  7  x  10\n');
  assert.equal(samples.size, 0);
});

test('overlayResources copies rss and cpu onto the session with that pid', () => {
  const snapshots: SessionSnapshot[] = [
    snapshot({ id: 'a', pid: 10 }),
    snapshot({ id: 'b', pid: 11 }),
    snapshot({ id: 'c' }),
  ];
  const samples = new Map<number, ProcessSample>([
    [10, { pid: 10, cpuPct: 4, rssBytes: 8_192 }],
  ]);
  const overlaid = overlayResources(snapshots, samples);
  assert.equal(overlaid[0].rssBytes, 8_192);
  assert.equal(overlaid[0].cpuPct, 4);
  assert.equal(overlaid[1].rssBytes, undefined);
  assert.equal(overlaid[2].pid, undefined);
  assert.equal(overlaid[2].rssBytes, undefined);
});

test('samplePids asks ps only for the given pids and returns an empty map when none', async () => {
  const calls: string[][] = [];
  const empty = await samplePids([], {
    execFile: async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(empty.size, 0);
  assert.equal(calls.length, 0);

  const samples = await samplePids([7, 7, 8], {
    execFile: async (file, args) => {
      calls.push([file, ...args]);
      assert.equal(file, 'ps');
      return { stdout: '7  1.0  2\n8  3.5  4\n', stderr: '' };
    },
  });
  assert.deepEqual(calls[0].slice(1), ['-o', 'pid=,pcpu=,rss=', '-p', '7,8']);
  assert.equal(samples.get(7)?.rssBytes, 2 * 1024);
  assert.equal(samples.get(8)?.cpuPct, 3.5);
});

test('samplePids returns an empty map when ps fails', async () => {
  const samples = await samplePids([1], {
    execFile: async () => {
      throw new Error('ps: no such process');
    },
  });
  assert.equal(samples.size, 0);
});

function snapshot(partial: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    id: 'id',
    name: 'name',
    kind: 'process',
    status: 'running',
    capabilities: [],
    startedAt: 0,
    ...partial,
  };
}
