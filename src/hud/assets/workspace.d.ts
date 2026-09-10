export function isLive(session: { status?: string }): boolean;
export function liveIds(sessions: { id?: string; status?: string }[]): string[];
export function projectTitle(path: string | undefined): string;
export type PackKind = 'workflow' | 'project';
export type SessionPack<T = object> = { kind: PackKind; id: string; title: string; sessions: T[] };
export function packSessions<T extends { workspace?: { id?: string; node?: string }; workflow?: string; root?: string }>(sessions: T[]): SessionPack<T>[];
export function sessionsForRoot<T extends { root?: string }>(sessions: T[], root: string): T[];
export function compactMark(item: {
  workspace?: { name?: string };
  workflow?: string;
  targets?: { kind?: string }[];
  sessions?: { kind?: string; workflow?: string }[];
}): { kind: 'ios' | 'android' | 'web' | 'workspace' | 'folder'; letter?: string };
export function nodeTone(status: string | undefined): 'ok' | 'busy' | 'warn' | 'bad' | 'idle' | 'external';
export function orderedNodes<T extends { name?: string; dependsOn?: string[] }>(
  run: { nodes?: Record<string, T> },
): T[];
