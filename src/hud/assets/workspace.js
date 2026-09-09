/**
 * Session packing for the control panel.
 *
 * A workflow is several processes that were launched together, often from
 * different project folders. Those stay in one pack so they can be seen and
 * stopped as a unit without mixing them into leftover single-project runs.
 */

/**
 * @param {{ status?: string }} session
 */
export function isLive(session) {
  return session.status === 'running' || session.status === 'starting';
}

/**
 * @param {{ id?: string, status?: string }[]} sessions
 * @returns {string[]}
 */
export function liveIds(sessions) {
  return sessions.filter(isLive).map((session) => session.id).filter(Boolean);
}

/**
 * @param {string | undefined} path
 */
export function projectTitle(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || 'unknown project';
}

/**
 * @typedef {'workflow' | 'project'} PackKind
 * @typedef {{ kind: PackKind, id: string, title: string, sessions: object[] }} SessionPack
 */

/**
 * @param {{ workflow?: string, root?: string }[]} sessions
 * @returns {SessionPack[]}
 */
export function packSessions(sessions) {
  const workflows = new Map();
  const projects = new Map();
  for (const session of sessions) {
    const workflow = String(session.workflow || '').trim();
    if (workflow) {
      const group = workflows.get(workflow) ?? [];
      group.push(session);
      workflows.set(workflow, group);
      continue;
    }
    const root = session.root ?? '';
    const group = projects.get(root) ?? [];
    group.push(session);
    projects.set(root, group);
  }
  const packs = [];
  for (const [id, group] of workflows) {
    packs.push({ kind: 'workflow', id, title: id, sessions: group });
  }
  for (const [id, group] of projects) {
    packs.push({ kind: 'project', id, title: projectTitle(id), sessions: group });
  }
  return packs;
}

/**
 * Sessions that belong to one remembered project, including workflow members.
 *
 * @param {{ root?: string }[]} sessions
 * @param {string} root
 */
export function sessionsForRoot(sessions, root) {
  return sessions.filter((session) => session.root === root);
}

/**
 * Glyph for the collapsed project strip: a platform, a web globe, or a
 * workspace letter. Flutter without a native sibling counts as iOS because
 * that is the usual local simulator.
 *
 * @param {{
 *   workflow?: string,
 *   targets?: { kind?: string }[],
 *   sessions?: { kind?: string, workflow?: string }[],
 * }} item
 * @returns {{ kind: 'ios' | 'android' | 'web' | 'workspace' | 'folder', letter?: string }}
 */
export function compactMark(item) {
  const workflow = String(item?.workflow || '').trim();
  if (workflow) {
    const ch = workflow.charAt(0);
    return { kind: 'workspace', letter: /[a-z]/i.test(ch) ? ch.toUpperCase() : 'W' };
  }
  const kinds = new Set();
  for (const target of item?.targets || []) {
    if (target?.kind) kinds.add(target.kind);
  }
  for (const session of item?.sessions || []) {
    if (session?.kind) kinds.add(session.kind);
  }
  const ios = kinds.has('ios') || kinds.has('flutter');
  const android = kinds.has('android');
  const web = kinds.has('web-dev') || kinds.has('react-native');
  if (android && !ios && !web) return { kind: 'android' };
  if (web && !ios && !android) return { kind: 'web' };
  if (ios && !android && !web) return { kind: 'ios' };
  if (android && !web) return { kind: 'android' };
  if (web) return { kind: 'web' };
  if (ios) return { kind: 'ios' };
  return { kind: 'folder' };
}
