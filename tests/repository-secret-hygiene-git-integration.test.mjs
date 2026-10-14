// End-to-end repository QA: the shipped secret scanner must reject genuinely
// git-tracked binary blobs, not merely pass synthetic in-memory unit tests.
// All fixtures live in a temporary local Git index; no network/real tokens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceFile = fileURLToPath(new URL('./repository-secret-hygiene.test.mjs', import.meta.url));
const workflow = fs.readFileSync(
  new URL('../.github/workflows/repository-secret-hygiene.yml', import.meta.url),
  'utf8'
);
const cmd = 'node tests/repository-secret-hygiene-git-integration.test.mjs';
assert.ok(workflow.includes('node tests/repository-secret-hygiene.test.mjs\n\n' +
  '      - name: Verify tracked binary scanning end-to-end') &&
  workflow.includes(cmd),
  'required secret workflow must run real tracked-binary integration after its scanner');
assert.match(workflow, /^  pull_request:\s*$/m,
  'real binary integration must execute on PRs');
assert.match(workflow, /^  push:\s*\n    branches:\s*\n      - main\s*$/m,
  'real binary integration must execute on every main push');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-hygiene-git-'));
const repoFile = path.join(tmp, 'fixtures', 'blob.bin');
const scannerCopy = path.join(tmp, 'tests', 'repository-secret-hygiene.test.mjs');
function git(...args) {
  return execFileSync('git', ['-C', tmp, ...args], {
    encoding: 'utf8', timeout: 5000
  });
}
function runScanner() {
  return spawnSync(process.execPath, [scannerCopy], {
    cwd: tmp, encoding: 'utf8', timeout: 7000,
    env: { ...process.env, CI: 'true' }
  });
}
function writeAndTrack(bytes) {
  fs.writeFileSync(repoFile, bytes);
  git('add', '--', 'fixtures/blob.bin');
  const paths = git('ls-files', '-z').split('\0').filter(Boolean);
  assert.ok(paths.includes('fixtures/blob.bin'),
    'the bytes must be in the actual Git index before scanning');
}
function accept(label) {
  const child = runScanner();
  assert.equal(child.status, 0, label + ': expected scanner success: ' +
    (child.stderr || '').slice(0, 700));
  assert.match(child.stdout, /repository secret hygiene contract passed/,
    label + ': must actually execute the shipped scanner');
}
function reject(label, signature, bytes, confidentialValue) {
  assert.ok(typeof confidentialValue === 'string' && confidentialValue.length > 0,
    label + ': the regression fixture must identify the value to protect');
  writeAndTrack(bytes);
  const child = runScanner();
  assert.equal(child.status, 1,
    label + ': a tracked binary secret must make the actual scanner fail');
  assert.match(child.stderr, /tracked repository content contains high-confidence secret material/,
    label + ': the scanner must reject the found credential, not crash or skip');
  assert.ok(child.stderr.includes('fixtures/blob.bin') &&
    child.stderr.includes(signature),
    label + ': failure must identify affected Git path and detected signature');
  // Diagnoses may name the tracked path and matching *signature*, but never
  // include the matched secret or private-key header in hosted Action logs.
  // Assert this on the real scanner's stdout and stderr, including failures.
  assert.ok(!(child.stdout + child.stderr).includes(confidentialValue),
    label + ': scanner diagnostics must not reveal matched secret values');
}

try {
  fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'fixtures'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'zbrowse'), { recursive: true });
  fs.copyFileSync(sourceFile, scannerCopy);
  fs.writeFileSync(path.join(tmp, 'zbrowse', '.env.example'), 'PORT=8090\n');
  git('init', '-q');
  writeAndTrack(Buffer.from([0, 255, 128, 10, 0, 40]));
  git('add', '--', 'tests/repository-secret-hygiene.test.mjs', 'zbrowse/.env.example');
  accept('benign NUL-containing tracked binary');

  const first = 'sk' + '-' + 'A'.repeat(32);
  reject('NUL-padded API secret', 'OpenAI-style secret',
    Buffer.concat([Buffer.from([0, 255, 128]),
      Buffer.from(first, 'ascii'), Buffer.from([0, 10])]), first);

  const second = 'github' + '_pat_' + 'B'.repeat(36);
  reject('invalid-UTF8-padded Git token', 'GitHub fine-grained token',
    Buffer.concat([Buffer.from([255, 254, 0]),
      Buffer.from('[' + second + ']', 'ascii'), Buffer.from([0, 128])]), second);

  // A Windows/PowerShell-style encoded secret has a NUL between each
  // ASCII character. Exercise both endiannesses against the *real* scanner
  // in a temporary tracked Git repository, not a replicated regex.
  reject('misaligned UTF-16LE API secret', 'OpenAI-style secret',
    Buffer.concat([Buffer.from([255]), Buffer.from(first, 'utf16le'),
      Buffer.from([0])]), first);
  reject('BOM-prefixed UTF-16BE Git token', 'GitHub fine-grained token',
    Buffer.concat([Buffer.from([0xfe, 0xff]),
      Buffer.from(Buffer.from(second, 'utf16le')).swap16(),
      Buffer.from([0])]), second);

  // The real tracked-file scan must also reject private-key header forms
  // frequently produced by encrypted PKCS#8, legacy DSA and OpenPGP tools.
  // Build fake markers at runtime so no credential-like literals are tracked.
  for (const [description, marker] of [
    ['encrypted PKCS#8', 'ENCRYPTED PRIVATE KEY'],
    ['legacy DSA', 'DSA PRIVATE KEY'],
    ['OpenPGP', 'PGP PRIVATE KEY BLOCK']
  ]) {
    const header = '-----BEGIN ' + marker + '-----';
    reject(description + ' raw tracked key header', 'PEM private key',
      Buffer.concat([Buffer.from([0, 255]), Buffer.from(header, 'ascii')]), header);
    reject(description + ' tracked UTF-16BE key header', 'PEM private key',
      Buffer.concat([Buffer.from([0x80, 0xfe, 0xff]),
        Buffer.from(Buffer.from(header, 'utf16le')).swap16()]), header);
  }

  // The policy must not mistake public keys or ordinary certificates for
  // private credentials even when they are tracked as binary fixtures.
  for (const marker of ['PUBLIC KEY', 'CERTIFICATE', 'PGP PUBLIC KEY BLOCK']) {
    writeAndTrack(Buffer.concat([Buffer.from([0, 255]),
      Buffer.from('-----BEGIN ' + marker + '-----', 'ascii')]));
    accept('benign tracked ' + marker + ' header');
  }

  writeAndTrack(Buffer.from([0, 255, 128, 10, 0, 40]));
  accept('safe binary after contaminated fixture is removed');
  console.log('Git-index secret-scan integration passed: safe binary, ' +
    'ten rejected binary/UTF-16/private-key tracked secrets, benign public headers, and recovery');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
