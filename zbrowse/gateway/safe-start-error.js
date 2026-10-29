/** Privacy-safe diagnostic category for failed zBrowse browser starts.
 * Unit helper only until the serialized gateway owner wires it into server.js.
 * No request object, Error, cause, URL, token or upstream text may reach logs.
 */
const SAFE_CODES = new Set([
  'EACCES', 'ECONNREFUSED', 'ECONNRESET', 'ENOSPC',
  'ETIMEDOUT', 'ENOENT', 'EPIPE',
]);

export function safeStartErrorCategory(error) {
  // Avoid evaluating arbitrary getters or proxies during incident logging.
  // A hostile Proxy may throw in getOwnPropertyDescriptor; fall back to a
  // static category instead of logging its exception.
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
      return 'BROWSER_START_FAILURE';
    }
    const own = Object.getOwnPropertyDescriptor(error, 'code');
    if (own && Object.hasOwn(own, 'value') && typeof own.value === 'string' &&
        SAFE_CODES.has(own.value)) {
      return own.value;
    }
  } catch {
    // No raw exception data may escape this diagnostic-only helper.
  }
  return 'BROWSER_START_FAILURE';
}
