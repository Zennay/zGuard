import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function filesAt(base, label) {
  const files = [];

  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const relative = path.join(prefix, name);
      const stat = fs.lstatSync(full);

      assert.ok(
        !stat.isSymbolicLink(),
        `${label} must not contain symlinked bundle entries: ${relative}`
      );

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

function filesIn(relativeDir) {
  return filesAt(path.join(root, relativeDir), relativeDir);
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zguard-bundle-parity-'));
try {
  const target = path.join(fixtureRoot, 'target.js');
  const alias = path.join(fixtureRoot, 'alias.js');
  fs.writeFileSync(target, 'export {};\n');
  fs.symlinkSync('target.js', alias);
  assert.throws(
    () => filesAt(fixtureRoot, 'fixture'),
    /must not contain symlinked bundle entries/
  );
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
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
