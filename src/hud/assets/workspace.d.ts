export function isLive(session: { status?: string }): boolean;
export function liveIds(sessions: { id?: string; status?: string }[]): string[];
export function projectTitle(path: string | undefined): string;
export type PackKind = 'workflow' | 'project';
export type SessionPack<T = object> = { kind: PackKind; id: string; title: string; sessions: T[] };
export function packSessions<T extends { workflow?: string; root?: string }>(sessions: T[]): SessionPack<T>[];
export function sessionsForRoot<T extends { root?: string }>(sessions: T[], root: string): T[];
