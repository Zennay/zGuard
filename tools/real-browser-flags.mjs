// Keep the real-browser acceptance CLI fail-closed: a typo must never turn a
// requested strict browser gate into the ordinary green default run.
const flags = new Map([
  ['--require-mainworld', 'requireMainWorld'],
  ['--cold-start', 'coldStart'],
  ['--require-auxclick', 'requireAuxclick'],
  ['--require-shadow-dom', 'requireShadowDom'],
  ['--require-form-submit', 'requireFormSubmit'],
  ['--require-image-map', 'requireImageMap'],
  ['--require-svg-link', 'requireSvgLink']
]);

export const acceptedBrowserFlags = Object.freeze([...flags.keys()]);

export function parseAcceptanceFlags(args) {
  if (!Array.isArray(args)) throw new TypeError('Browser acceptance arguments must be an array');
  const result = Object.fromEntries([...flags.values()].map((name) => [name, false]));
  const seen = new Set();
  for (const arg of args) {
    if (typeof arg !== 'string' || !flags.has(arg)) {
      throw new Error('Unsupported real-browser acceptance argument: ' + String(arg));
    }
    if (seen.has(arg)) {
      throw new Error('Duplicate real-browser acceptance argument: ' + arg);
    }
    seen.add(arg);
    result[flags.get(arg)] = true;
  }
  return Object.freeze(result);
}
