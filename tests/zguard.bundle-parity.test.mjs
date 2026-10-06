import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function filesIn(relativeDir) {
  const base = path.join(root, relativeDir);
  const files = [];

  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const relative = path.join(prefix, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, relative);
      } else if (stat.isFile()) {
        files.push({
          path: relative.split(path.sep).join('/'),
          content: fs.readFileSync(full),
        });
      }
    }
  }

  walk(base);
  return files;
}

const canonical = filesIn('chromium');
const bundled = filesIn('zbrowse/browser/zguard');

assert.deepEqual(
  bundled.map((file) => file.path),
  canonical.map((file) => file.path),
  'zBrowse must bundle exactly the canonical Chromium zGuard file set'
);

for (let index = 0; index < canonical.length; index += 1) {
  assert.equal(
    Buffer.compare(bundled[index].content, canonical[index].content),
    0,
    `zBrowse bundled zGuard file drifted: ${canonical[index].path}`
  );
}

console.log('zGuard bundled Chromium package parity passed');
