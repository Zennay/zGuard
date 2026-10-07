import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8'
}).split('\0').filter(Boolean);

const start = '<'.repeat(7);
const separator = '='.repeat(7);
const end = '>'.repeat(7);
const findings = [];

for (const file of tracked) {
  const full = path.join(root, file);
  const buffer = fs.readFileSync(full);

  if (buffer.includes(0)) continue;

  const lines = buffer.toString('utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.startsWith(start) || line === separator || line.startsWith(end)) {
      findings.push(`${file}:${index + 1}: ${line.slice(0, 120)}`);
    }
  });
}

assert.deepEqual(
  findings,
  [],
  `tracked files must not contain unresolved Git conflict markers:\n${findings.join('\n')}`
);

console.log(`Repository conflict-marker contract passed for ${tracked.length} tracked files`);
