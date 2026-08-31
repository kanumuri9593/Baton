/**
 * Log and network inspector predicates.
 *
 * Pure functions so the HUD chips and the tests share one implementation.
 * A typo'd regex falls back to a substring rather than matching nothing —
 * that failure mode looks identical to "no traffic matched".
 */

/** @typedef {{ text: string, error?: boolean }} LogLine */

/** @typedef {'all' | 'errors' | 'ok'} LogLevel */

/** @typedef {'all' | 'ok' | 'redirects' | 'errors' | 'inflight'} NetStatus */

/** @typedef {{ level: LogLevel, text?: string }} LogFilter */

/**
 * @typedef {object} NetFilter
 * @property {NetStatus} status
 * @property {string[]} methods
 * @property {boolean} hideNoise
 * @property {string} [text]
 */

/** Images, fonts, and the usual analytics beacons. Off until the Hide-noise chip is on. */
const NOISE =
  /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot)(\?|$)|google-analytics|doubleclick|facebook\.com\/tr|hotjar|segment\.io|googletagmanager/i;

/**
 * @param {string | undefined} text
 * @param {string} haystack
 */
function matchesText(haystack, text) {
  const needle = (text || '').trim();
  if (!needle) return true;
  try {
    return new RegExp(needle, 'i').test(haystack);
  } catch {
    return haystack.toLowerCase().includes(needle.toLowerCase());
  }
}

/**
 * PUT and PATCH share one chip — they are both "write a resource" in the 90% case.
 * @param {string} method
 */
export function methodGroup(method) {
  const upper = String(method || '').toUpperCase();
  if (upper === 'PUT' || upper === 'PATCH') return 'PUT/PATCH';
  return upper;
}

/**
 * @param {LogLine} line
 * @param {LogFilter} filter
 */
export function matchLog(line, filter) {
  if (filter.level === 'errors' && !line.error) return false;
  if (filter.level === 'ok' && line.error) return false;
  return matchesText(line.text || '', filter.text);
}

/**
 * @param {{ method?: string, uri?: string, statusCode?: number, error?: string, inProgress?: boolean }} row
 * @param {NetFilter} filter
 */
export function matchNetwork(row, filter) {
  if (filter.hideNoise && NOISE.test(row.uri || '')) return false;

  const status = filter.status || 'all';
  if (status === 'inflight' && !row.inProgress) return false;
  if (status === 'ok') {
    const code = row.statusCode;
    if (code === undefined || code < 200 || code >= 300) return false;
  }
  if (status === 'redirects') {
    const code = row.statusCode;
    if (code === undefined || code < 300 || code >= 400) return false;
  }
  if (status === 'errors') {
    const failed = Boolean(row.error) || (row.statusCode !== undefined && row.statusCode >= 400);
    if (!failed) return false;
  }

  if (filter.methods && filter.methods.length) {
    const group = methodGroup(row.method);
    if (!filter.methods.includes(group) && !filter.methods.includes(String(row.method || '').toUpperCase())) {
      return false;
    }
  }

  return matchesText(`${row.method || ''} ${row.uri || ''}`, filter.text);
}
