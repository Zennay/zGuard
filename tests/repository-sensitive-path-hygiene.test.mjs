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

const findings = [];

for (const relative of tracked) {
  const normalized = relative.replaceAll('\\', '/');
  const base = path.posix.basename(normalized);
  const segments = normalized.split('/');

  if (looksLikeEnvironmentFile(base)) {
    findings.push(`${relative}: tracked environment file`);
    continue;
  }

  if (containsSshDirectory(segments)) {
    findings.push(`${relative}: tracked SSH material`);
    continue;
  }

  if (privateKeyNames.test(base) || privateKeyExtensions.test(base)) {
    findings.push(`${relative}: tracked private-key/keystore path`);
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
