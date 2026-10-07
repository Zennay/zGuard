import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8'
}).split('\0').filter(Boolean);

function firstLine(file) {
  const full = path.join(root, file);
  const fd = fs.openSync(full, 'r');
  try {
    const buffer = Buffer.alloc(256);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/, 1)[0];
  } finally {
    fs.closeSync(fd);
  }
}

const shellFiles = tracked.filter((file) => {
  if (file.endsWith('.sh')) return true;
  return /^#!.*\bbash(?:\s|$)/.test(firstLine(file));
}).sort();

assert.ok(shellFiles.length > 0, 'at least one tracked Bash script must be discovered');

for (const file of shellFiles) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const lines = source.split(/\r?\n/);

  assert.equal(
    lines[0],
    '#!/usr/bin/env bash',
    `${file} must use the portable #!/usr/bin/env bash shebang`
  );

  const firstStatement = lines
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'));

  assert.equal(
    firstStatement,
    'set -euo pipefail',
    `${file} must enable set -euo pipefail before executing commands`
  );

  const result = spawnSync('bash', ['-n', file], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.equal(
    result.status,
    0,
    `${file} must pass bash -n:\n${result.stderr || result.stdout}`
  );
}

console.log(
  `Repository shell safety contract passed for ${shellFiles.length} tracked Bash scripts`
);
