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

const findings = [];

for (const relative of tracked) {
  const normalized = relative.replaceAll('\\', '/');
  const base = path.posix.basename(normalized);
  const segments = normalized.split('/');

  if (base === '.env' || (base.startsWith('.env.') && !allowedEnvExamples.has(base))) {
    findings.push(`${relative}: tracked environment file`);
    continue;
  }

  if (segments.includes('.ssh')) {
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
