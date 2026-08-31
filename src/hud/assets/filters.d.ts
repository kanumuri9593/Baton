export type LogLevel = 'all' | 'errors' | 'ok';
export type NetStatus = 'all' | 'ok' | 'redirects' | 'errors' | 'inflight';

export function methodGroup(method: string): string;
export function matchLog(
  line: { text: string; error?: boolean },
  filter: { level: LogLevel; text?: string },
): boolean;
export function matchNetwork(
  row: { method?: string; uri?: string; statusCode?: number; error?: string; inProgress?: boolean },
  filter: { status: NetStatus; methods: string[]; hideNoise: boolean; text?: string },
): boolean;
