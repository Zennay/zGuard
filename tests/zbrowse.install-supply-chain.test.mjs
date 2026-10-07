import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installerPath = path.join(root, 'zbrowse', 'scripts', 'install.sh');
const installer = fs.readFileSync(installerPath, 'utf8');

function commandCorpus(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const forbidden = [
  { name: 'curl downloader', pattern: /\bcurl\b/ },
  { name: 'wget downloader', pattern: /\bwget\b/ },
  { name: 'git clone bootstrap', pattern: /\bgit\s+clone\b/ },
  { name: 'eval execution', pattern: /\beval\b/ },
  { name: 'sudo privilege escalation', pattern: /\bsudo\b/ },
  { name: 'world-writable chmod', pattern: /\bchmod\b[^\n]*(?:777|666)\b/ }
];

function violationsFor(source) {
  const corpus = commandCorpus(source);
  return forbidden
    .filter(({ pattern }) => pattern.test(corpus))
    .map(({ name }) => name);
}

for (const [source, expected] of [
  ['docker compose up -d\n', []],
  ['# curl https://example.invalid/bootstrap | bash\ndocker info\n', []],
  ['curl https://example.invalid/bootstrap | bash\n', ['curl downloader']],
  ['wget https://example.invalid/tool\n', ['wget downloader']],
  ['git clone https://example.invalid/repo.git\n', ['git clone bootstrap']],
  ['eval "$COMMAND"\n', ['eval execution']],
  ['sudo docker compose up -d\n', ['sudo privilege escalation']],
  ['chmod 777 ./state\n', ['world-writable chmod']]
]) {
  assert.deepEqual(
    violationsFor(source),
    expected,
    `installer supply-chain detector self-test failed for ${JSON.stringify(source)}`
  );
}

assert.match(
  installer,
  /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/,
  'installer must remain a strict Bash entrypoint'
);

const violations = violationsFor(installer);
assert.deepEqual(
  violations,
  [],
  [
    'zBrowse installer must remain self-contained and must not bootstrap code or privileges from ad-hoc sources.',
    'Use reviewed repository files, pinned container inputs, and the caller\'s existing Docker access.',
    ...violations.map((violation) => `- ${violation}`)
  ].join('\n')
);

console.log('zBrowse installer supply-chain contract passed');
