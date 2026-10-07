import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8'
}).split('\0').filter(Boolean).sort();

assert.ok(tracked.length > 0, 'repository must contain tracked files');

function binaryKind(bytes) {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return 'ELF executable/object';
  }

  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    return 'PE/DOS executable';
  }

  if (bytes.length >= 4) {
    const magic = bytes.readUInt32BE(0);
    const machO = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe]);
    if (machO.has(magic)) return 'Mach-O executable/object';
    if (magic === 0xcafebabe) return 'Java class/fat Mach-O binary';
    if (magic === 0x0061736d) return 'WebAssembly binary';
  }

  return null;
}

const fixtures = [
  [Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 'ELF executable/object'],
  [Buffer.from([0x4d, 0x5a, 0x90, 0x00]), 'PE/DOS executable'],
  [Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), 'Mach-O executable/object'],
  [Buffer.from([0xca, 0xfe, 0xba, 0xbe]), 'Java class/fat Mach-O binary'],
  [Buffer.from([0x00, 0x61, 0x73, 0x6d]), 'WebAssembly binary']
];

for (const [bytes, expected] of fixtures) {
  assert.equal(binaryKind(bytes), expected, `binary magic self-test must detect ${expected}`);
}

for (const bytes of [
  Buffer.from('#!/usr/bin/env node\n'),
  Buffer.from('<!doctype html>'),
  Buffer.from('{"name":"zguard"}')
]) {
  assert.equal(binaryKind(bytes), null, 'ordinary source/text fixture must remain allowed');
}

const findings = [];

for (const relative of tracked) {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile()) continue;

  const fd = fs.openSync(absolute, 'r');
  try {
    const prefix = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, prefix, 0, prefix.length, 0);
    const kind = binaryKind(prefix.subarray(0, bytesRead));
    if (kind) findings.push(`${relative}: tracked ${kind}`);
  } finally {
    fs.closeSync(fd);
  }
}

assert.deepEqual(
  findings,
  [],
  [
    'tracked repository files must not contain compiled executable/bytecode magic',
    ...findings.map((finding) => `- ${finding}`),
    'Build executable and bytecode artifacts in CI/runtime stages instead of committing or disguising binaries.'
  ].join('\n')
);

console.log(
  `Repository binary-magic hygiene contract passed for ${tracked.length} tracked files`
);
