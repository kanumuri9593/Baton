import type { WorkspaceManifest } from './manifest.ts';

/**
 * Everything that must be true before a single process starts.
 *
 * Bring-up is parallel and partly irreversible, so the graph is checked whole:
 * a cycle discovered halfway up would leave a half-started system behind.
 */
export function validateGraph(manifest: WorkspaceManifest): void {
  const names = new Set(Object.keys(manifest.nodes));

  for (const [name, node] of Object.entries(manifest.nodes)) {
    for (const dep of node.dependsOn) {
      if (dep === name) throw new Error(`${name} depends on itself`);
      if (!names.has(dep)) {
        throw new Error(`${name} depends on "${dep}", which is not a node in this workspace`);
      }
    }
    if (new Set(node.dependsOn).size !== node.dependsOn.length) {
      throw new Error(`${name} lists the same dependency twice`);
    }
  }

  const cycle = findCycle(manifest);
  if (cycle) throw new Error(`dependencies form a cycle: ${cycle.join(' -> ')}`);

  // Exports of a node's direct dependencies are merged into one env block, so a
  // shared key would mean one dependency silently shadowing another.
  for (const [name, node] of Object.entries(manifest.nodes)) {
    const seen = new Map<string, string>();
    for (const dep of node.dependsOn) {
      for (const key of Object.keys(manifest.nodes[dep].exports)) {
        const owner = seen.get(key);
        if (owner) {
          throw new Error(`${name} depends on both ${owner} and ${dep}, and both export ${key}`);
        }
        seen.set(key, dep);
      }
    }
  }
}

/** The path around one cycle, starting and ending at the same node. */
function findCycle(manifest: WorkspaceManifest): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const walk = (name: string): string[] | undefined => {
    const seen = state.get(name);
    if (seen === 'done') return undefined;
    if (seen === 'visiting') return [...stack.slice(stack.indexOf(name)), name];
    state.set(name, 'visiting');
    stack.push(name);
    for (const dep of manifest.nodes[name].dependsOn) {
      const found = walk(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(name, 'done');
    return undefined;
  };

  for (const name of Object.keys(manifest.nodes)) {
    const found = walk(name);
    if (found) return found;
  }
  return undefined;
}

/**
 * Start order as waves: everything in one level can start at once because
 * nothing in it waits for anything else in it.
 */
export function topoLevels(manifest: WorkspaceManifest): string[][] {
  const remaining = new Map(Object.entries(manifest.nodes).map(([name, node]) => [name, new Set(node.dependsOn)]));
  const levels: string[][] = [];
  const placed = new Set<string>();

  while (remaining.size > 0) {
    const level = [...remaining.entries()]
      .filter(([, deps]) => [...deps].every((d) => placed.has(d)))
      .map(([name]) => name);
    if (level.length === 0) throw new Error('dependencies form a cycle'); // validateGraph names it
    for (const name of level) {
      remaining.delete(name);
      placed.add(name);
    }
    levels.push(level);
  }
  return levels;
}

/** Every node that would be affected by this one, directly or through others. */
export function dependentsOf(manifest: WorkspaceManifest, node: string): string[] {
  const affected = new Set<string>();
  const queue = [node];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [name, declared] of Object.entries(manifest.nodes)) {
      if (!declared.dependsOn.includes(current) || affected.has(name)) continue;
      affected.add(name);
      queue.push(name);
    }
  }
  affected.delete(node);
  return [...affected];
}

/** Shutdown order: dependents before what they depend on. */
export function reverseTopo(manifest: WorkspaceManifest): string[] {
  return topoLevels(manifest).reverse().flat();
}
