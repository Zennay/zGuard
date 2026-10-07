import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const maxTrackedBytes = 2 * 1024 * 1024;

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8'
}).split('\0').filter(Boolean).sort();

assert.ok(tracked.length > 0, 'repository must contain tracked files');

const oversized = [];

for (const relative of tracked) {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);

  if (stat.isSymbolicLink()) continue;
  if (!stat.isFile()) continue;

  if (stat.size > maxTrackedBytes) {
    oversized.push({
      path: relative,
      bytes: stat.size
    });
  }
}

assert.deepEqual(
  oversized,
  [],
  [
    `tracked files must stay at or below ${maxTrackedBytes} bytes (2 MiB)`,
    ...oversized.map(({ path: relative, bytes }) => `- ${relative}: ${bytes} bytes`),
    'Store generated/build artifacts outside git or use a reviewed artifact/LFS path instead.'
  ].join('\n')
);

console.log(
  `Repository large-file integrity contract passed for ${tracked.length} tracked files (max 2 MiB)`
);
