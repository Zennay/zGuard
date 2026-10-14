import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8'
}).split('\0').filter(Boolean).sort();

assert.ok(tracked.length > 0, 'repository must contain tracked files');

const allowedEnvExamples = new Set([
  '.env.example',
  '.env.sample',
  '.env.template'
]);

const privateKeyNames = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|identity)$/i;
const privateKeyExtensions = /\.(?:pem|key|p12|pfx|jks|keystore)$/i;

function looksLikeEnvironmentFile(base) {
  const normalized = base.toLowerCase();
  return normalized === '.env' || (
    normalized.startsWith('.env.') && !allowedEnvExamples.has(normalized)
  );
}

function containsSshDirectory(segments) {
  return segments.some((segment) => segment.toLowerCase() === '.ssh');
}

assert.equal(looksLikeEnvironmentFile('.ENV'), true);
assert.equal(looksLikeEnvironmentFile('.Env.Local'), true);
assert.equal(looksLikeEnvironmentFile('.ENV.EXAMPLE'), false);
assert.equal(containsSshDirectory(['docs', '.SSH', 'id_ed25519']), true);

// Git accepts paths with embedded newlines, terminal escapes and Unicode
// directional controls. Never print a raw Git filename into CI diagnostics.
function escapeDiagnosticPath(relative) {
  return JSON.stringify(relative).replace(
    /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

for (const hostile of [
  'config\\nFORGED SUCCESS\\u001b[2J'.replace('\\n', '\n').replace('\\u001b', '\u001b'),
  'rtl\\u202ePASS'.replace('\\u202e', '\u202e')
]) {
  const safe = escapeDiagnosticPath(hostile);
  assert.doesNotMatch(safe, /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u,
    'diagnostic paths must never contain terminal controls or bidi overrides');
  assert.notEqual(safe, hostile, 'hostile path must be escaped');
}

const findings = [];

for (const relative of tracked) {
  const normalized = relative.replaceAll('\\', '/');
  const base = path.posix.basename(normalized);
  const segments = normalized.split('/');

  if (looksLikeEnvironmentFile(base)) {
    findings.push(`${escapeDiagnosticPath(relative)}: tracked environment file`);
    continue;
  }

  if (containsSshDirectory(segments)) {
    findings.push(`${escapeDiagnosticPath(relative)}: tracked SSH material`);
    continue;
  }

  if (privateKeyNames.test(base) || privateKeyExtensions.test(base)) {
    findings.push(`${escapeDiagnosticPath(relative)}: tracked private-key/keystore path`);
  }
}

assert.deepEqual(
  findings,
  [],
  [
    'tracked repository paths must not look like local secret-bearing material',
    ...findings.map((finding) => `- ${finding}`),
    'Use explicit .example/.sample/.template env files and keep private keys/keystores outside git.'
  ].join('\n')
);

console.log(
  `Repository sensitive-path hygiene contract passed for ${tracked.length} tracked files`
);
