// A mistyped opt-in QA flag must never produce a successful baseline run.
// Accept exactly zero arguments (ordinary scope) or one declared strict gate.
export function parseStrictAcceptanceArgs(args, expectedFlag) {
  if (!Array.isArray(args) || typeof expectedFlag !== 'string' ||
      !/^--require-[a-z]+(?:-[a-z]+)*$/.test(expectedFlag)) {
    throw new TypeError('Invalid strict acceptance CLI contract');
  }
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === expectedFlag) return true;
  throw new Error('Invalid strict acceptance arguments for ' + expectedFlag);
}
