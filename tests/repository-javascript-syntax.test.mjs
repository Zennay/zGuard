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

const NODE_SHEBANG = /^#!.*(?:\/|\s)node(?:\s|$)/;

function firstLine(file) {
  const fd = fs.openSync(path.join(root, file), 'r');
  try {
    const buffer = Buffer.alloc(256);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/, 1)[0];
  } finally {
    fs.closeSync(fd);
  }
}

function isJavaScriptFile(file) {
  return /\.(?:cjs|mjs|js)$/i.test(file) || NODE_SHEBANG.test(firstLine(file));
}

assert.match('#!/usr/bin/env node', NODE_SHEBANG);
assert.match('#!/usr/bin/env -S node --trace-warnings', NODE_SHEBANG);
assert.match('#!/usr/bin/node', NODE_SHEBANG);
assert.doesNotMatch('#!/usr/bin/env bash', NODE_SHEBANG);
assert.match('fixture.JS', /\.(?:cjs|mjs|js)$/i);
assert.doesNotMatch('fixture.js.map', /\.(?:cjs|mjs|js)$/i);

const javascriptFiles = tracked
  .filter(isJavaScriptFile)
  .sort();

assert.ok(javascriptFiles.length > 0, 'at least one tracked JavaScript file must be discovered');

for (const file of javascriptFiles) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.equal(
    result.status,
    0,
    `${file} must pass node --check:\n${result.stderr || result.stdout}`
  );
}

console.log(`Repository JavaScript syntax contract passed for ${javascriptFiles.length} tracked files`);
