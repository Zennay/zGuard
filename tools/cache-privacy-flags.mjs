// Strict privacy acceptance must fail closed before a token-bearing gateway
// fixture is constructed. A typo must not produce an ordinary green result.
export function requireExactCachePrivacyFlag(args) {
  if (!Array.isArray(args)) throw new TypeError('Cache privacy CLI args must be an array');
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === '--require-no-store') return true;
  throw new Error('Unsupported cache-privacy acceptance arguments: expected --require-no-store');
}
