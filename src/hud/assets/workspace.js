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
