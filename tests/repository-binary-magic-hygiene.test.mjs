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

const prefixSignatures = [
  [Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 'ELF executable/object'],
  [Buffer.from([0x4d, 0x5a]), 'PE/DOS executable'],
  [Buffer.from([0xfe, 0xed, 0xfa, 0xce]), 'Mach-O executable/object'],
  [Buffer.from([0xce, 0xfa, 0xed, 0xfe]), 'Mach-O executable/object'],
  [Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), 'Mach-O executable/object'],
  [Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), 'Mach-O executable/object'],
  [Buffer.from([0xca, 0xfe, 0xba, 0xbe]), 'Java class/fat Mach-O binary'],
  [Buffer.from([0x00, 0x61, 0x73, 0x6d]), 'WebAssembly binary'],
  [Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'ZIP archive'],
  [Buffer.from([0x50, 0x4b, 0x05, 0x06]), 'ZIP archive'],
  [Buffer.from([0x50, 0x4b, 0x07, 0x08]), 'ZIP archive'],
  [Buffer.from([0x1f, 0x8b]), 'gzip archive'],
  [Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), 'XZ archive'],
  [Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), '7z archive'],
  [Buffer.from([0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a]), 'ar archive'],
  [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), 'RAR archive'],
  [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]), 'RAR archive']
];

const tarMagicOffset = 257;
const tarMagic = Buffer.from('ustar');
const scanBytes = Math.max(
  ...prefixSignatures.map(([signature]) => signature.length),
  tarMagicOffset + tarMagic.length
);

function hasPrefix(bytes, signature) {
  return bytes.length >= signature.length &&
    bytes.subarray(0, signature.length).equals(signature);
}

function binaryKind(bytes) {
  for (const [signature, kind] of prefixSignatures) {
    if (hasPrefix(bytes, signature)) return kind;
  }

  if (
    bytes.length >= 4 &&
    bytes.subarray(0, 3).equals(Buffer.from('BZh')) &&
    bytes[3] >= 0x31 &&
    bytes[3] <= 0x39
  ) {
    return 'bzip2 archive';
  }

  if (
    bytes.length >= tarMagicOffset + tarMagic.length &&
    bytes.subarray(tarMagicOffset, tarMagicOffset + tarMagic.length).equals(tarMagic)
  ) {
    return 'TAR archive';
  }

  return null;
}

for (const [bytes, expected] of prefixSignatures) {
  assert.equal(binaryKind(bytes), expected, `binary magic self-test must detect ${expected}`);
}

assert.equal(
  binaryKind(Buffer.from('BZh9compressed')),
  'bzip2 archive',
  'binary magic self-test must detect bzip2 archives'
);
assert.equal(
  binaryKind(Buffer.from('BZh0not-bzip2')),
  null,
  'bzip2 detection must require a valid block-size digit'
);

const tarFixture = Buffer.alloc(tarMagicOffset + tarMagic.length);
tarMagic.copy(tarFixture, tarMagicOffset);
assert.equal(binaryKind(tarFixture), 'TAR archive', 'binary magic self-test must detect POSIX tar headers');

const truncatedTarFixture = Buffer.alloc(tarMagicOffset + tarMagic.length - 1);
tarMagic.subarray(0, tarMagic.length - 1).copy(truncatedTarFixture, tarMagicOffset);
assert.equal(binaryKind(truncatedTarFixture), null, 'TAR detection must require the complete ustar magic');

assert.equal(
  binaryKind(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x00, 0x00])),
  null,
  '7z detection must require the complete six-byte signature'
);
assert.equal(
  binaryKind(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])),
  null,
  'RAR detection must reject truncated signature prefixes'
);
assert.equal(
  scanBytes,
  262,
  'repository scan must read through the longest supported offset signature'
);

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
    const prefix = Buffer.alloc(scanBytes);
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
    'tracked repository files must not contain opaque executable/bytecode/archive magic',
    ...findings.map((finding) => `- ${finding}`),
    'Build executable, bytecode and archive artifacts in CI/release stages instead of committing or disguising opaque binaries.'
  ].join('\n')
);

console.log(
  `Repository binary-magic hygiene contract passed for ${tracked.length} tracked files`
);
