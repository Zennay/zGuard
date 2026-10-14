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
  // Real repositories normally have HEAD. Commit a clean baseline so the
  // staged mismatch fixtures exercise an actual diff against a prior tree,
  // rather than relying only on the unborn-branch index case.
  git('-c', 'user.name=QA Fixture', '-c', 'user.email=qa@invalid.example',
    'commit', '-q', '-m', 'safe synthetic baseline');
  accept('clean committed baseline');

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

  // A complete real Git-index run must detect UTF-32 too; the in-memory
  // decoder regression alone would not prove the shipped scanner executes.
  function utf32(value, bigEndian) {
    const bytes = Buffer.alloc(value.length * 4);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      assert.ok(code >= 0x20 && code <= 0x7e);
      bytes[i * 4 + (bigEndian ? 3 : 0)] = code;
    }
    return bytes;
  }
  reject('misaligned UTF-32LE API secret', 'OpenAI-style secret',
    Buffer.concat([Buffer.from([0xff, 0x80, 0xfe]),
      utf32(first, false), Buffer.from([0])]), first);
  reject('BOM-prefixed UTF-32BE Git token', 'GitHub fine-grained token',
    Buffer.concat([Buffer.from([0, 0, 0xfe, 0xff]),
      utf32(second, true), Buffer.from([0])]), second);

  // A word or filename may contain a GitHub-shaped suffix without being
  // a standalone token. Enforce this through the same real Git-index scanner,
  // not only an isolated regex, while keeping real Bearer tokens detectable.
  const classic = 'gh' + 'p_' + 'B'.repeat(30);
  reject('standalone GitHub classic Bearer', 'GitHub classic token',
    Buffer.from('Bearer ' + classic, 'ascii'), classic);
  for (const [label, input] of [
    ['embedded classic token-shaped suffix', 'prefix' + classic],
    ['embedded fine-grained suffix', 'filename_' + second],
    ['short classic prefix', classic.slice(0, -12)]
  ]) {
    writeAndTrack(Buffer.from(input, 'ascii'));
    accept(label + ' must not be treated as a credential');
  }

  // AWS and Slack identifiers deserve the same standalone-vs-embedded
  // boundary proof as GitHub keys; test the copied production scanner.
  const aws = 'AK' + 'IA' + 'D'.repeat(16);
  const slack = 'xox' + 'b-' + 'E'.repeat(30);
  reject('standalone AWS access key', 'AWS access key id',
    Buffer.from('AWS_ACCESS_KEY_ID=' + aws, 'ascii'), aws);
  reject('standalone Slack bot bearer', 'Slack bot token',
    Buffer.from('Bearer ' + slack, 'ascii'), slack);
  for (const [label, value] of [
    ['AWS-shaped substring in filename', 'prefix' + aws],
    ['Slack-shaped suffix in identifier', 'filename_' + slack]
  ]) {
    writeAndTrack(Buffer.from(value, 'ascii'));
    accept(label + ' must not be rejected as a leaked credential');
  }

  // The policy must not mistake public keys or ordinary certificates for
  // private credentials even when they are tracked as binary fixtures.
  for (const marker of ['PUBLIC KEY', 'CERTIFICATE', 'PGP PUBLIC KEY BLOCK']) {
    writeAndTrack(Buffer.concat([Buffer.from([0, 255]),
      Buffer.from('-----BEGIN ' + marker + '-----', 'ascii')]));
    accept('benign tracked ' + marker + ' header');
  }

  // Git allows control characters in tracked filenames. A matching
  // synthetic secret must not cause a newline/ANSI injection in CI logs.
  // Exercise the exact scanner with a real pathname containing both.
  writeAndTrack(Buffer.from([0, 255, 128, 10, 0, 40]));
  const unsafeName = 'newline\nbold-\x1b[31m.bin';
  const unsafeRelative = 'fixtures/' + unsafeName;
  fs.writeFileSync(path.join(tmp, unsafeRelative), Buffer.from(first, 'ascii'));
  git('add', '--', unsafeRelative);
  const unsafeResult = runScanner();
  assert.equal(unsafeResult.status, 1,
    'tracked control-character filename carrying a key must fail the scanner');
  assert.ok(unsafeResult.stderr.includes(JSON.stringify(unsafeRelative)),
    'diagnostics must quote and escape the actual tracked filename');
  assert.equal(unsafeResult.stderr.includes(unsafeRelative), false,
    'raw newline/control bytes from Git paths must never appear in diagnostics');
  assert.equal(unsafeResult.stderr.includes('\x1b'), false,
    'literal terminal escape must never be emitted into CI logs');
  assert.equal((unsafeResult.stdout + unsafeResult.stderr).includes(first), false,
    'diagnostics must not print the matched synthetic secret');
  // A hostile path can also contain a staged-only secret with clean on-disk
  // content. Require Git's index-blob lookup to preserve literal filenames
  // while the published diagnostic remains JSON escaped.
  const safeTracked = Buffer.from([0, 255, 128, 10, 0, 40]);
  fs.writeFileSync(path.join(tmp, unsafeRelative), safeTracked);
  const indexOnlyUnsafe = runScanner();
  assert.equal(indexOnlyUnsafe.status, 1,
    'staged-only credential in a path containing newline/ESC must be rejected');
  assert.ok(indexOnlyUnsafe.stderr.includes(
    JSON.stringify(unsafeRelative + ' (staged index)')),
    'staged-only warning must escape untrusted Git path bytes');
  assert.ok(!(indexOnlyUnsafe.stdout + indexOnlyUnsafe.stderr).includes(first),
    'staged-only warning must not disclose synthetic credential');
  assert.equal(indexOnlyUnsafe.stderr.includes(unsafeRelative), false,
    'raw hostile Git filename must never reach scanner log output');
  // The fixture was staged but never committed: force its removal from the
  // disposable Git index and disk without emitting the unsafe pathname.
  git('rm', '-f', '-q', '--', unsafeRelative);

  // Git commits record the staged index version, which may differ from
  // the checkout on disk. This is a real staged-secret bypass if the scanner
  // only reads fs.readFileSync() for each tracked file.
  const cleanBinary = Buffer.from([0, 255, 128, 10, 0, 40]);
  writeAndTrack(Buffer.from(first, 'ascii'));
  fs.writeFileSync(repoFile, cleanBinary);
  const stagedLeak = runScanner();
  assert.equal(stagedLeak.status, 1,
    'staged credential must fail even after worktree was replaced by safe bytes');
  assert.ok(stagedLeak.stderr.includes('fixtures/blob.bin (staged index)') &&
    stagedLeak.stderr.includes('OpenAI-style secret'),
    'rejection must identify the Git index source and secret family');
  assert.ok(!(stagedLeak.stdout + stagedLeak.stderr).includes(first),
    'staged credential value must never appear in scanner logs');

  // Also keep protecting the inverse: an unstaged secret in the checkout
  // must not be overlooked because the corresponding index blob is clean.
  writeAndTrack(cleanBinary);
  fs.writeFileSync(repoFile, Buffer.from(first, 'ascii'));
  const worktreeLeak = runScanner();
  assert.equal(worktreeLeak.status, 1,
    'unstaged worktree credential must fail despite a safe staged index blob');
  assert.ok(worktreeLeak.stderr.includes('fixtures/blob.bin') &&
    worktreeLeak.stderr.includes('OpenAI-style secret'),
    'worktree rejection must retain path and signature evidence');
  assert.ok(!(worktreeLeak.stdout + worktreeLeak.stderr).includes(first),
    'unstaged credential value must never appear in scanner logs');

  writeAndTrack(Buffer.from([0, 255, 128, 10, 0, 40]));

  // Config-policy bypass: staging a forbidden field (or an empty default),
  // then restoring a safe worktree copy, must still fail the shipped checker.
  const envPath = path.join(tmp, 'zbrowse', '.env.example');
  const safeExample = 'PORT=8090\n';
  for (const [label, stagedExample] of [
    ['credential-bearing field name', 'PORT=8090\nSERVICE_PASSWORD=qa-placeholder\n'],
    ['spaced credential assignment', 'PORT=8090\nSERVICE_PASSWORD  =qa-placeholder\n'],
    ['export-prefixed credential assignment', 'PORT=8090\nexport SERVICE_PASSWORD =qa-placeholder\n'],
    ['tab-separated credential assignment', 'PORT=8090\nSERVICE_TOKEN\t=qa-placeholder\n'],
    ['missing explicit default', 'PORT=8090\nSERVICE_MODE=\n'],
    ['whitespace-only default', 'PORT=8090\nSERVICE_MODE=  \n'],
    ['comment-only default', 'PORT=8090\nSERVICE_MODE=# unset\n'],
    ['spaced comment-only default', 'PORT=8090\nSERVICE_MODE= # unset\n'],
    ['empty double-quoted default', 'PORT=8090\nSERVICE_MODE=""\n'],
    ['empty single-quoted default', "PORT=8090\\nSERVICE_MODE=''\\n".replaceAll('\\n', '\n')],
    ['whitespace quoted default', 'PORT=8090\nSERVICE_MODE="   "\n'],
    ['unterminated quoted default', 'PORT=8090\nSERVICE_MODE="pending\n'],
    ['garbage after quoted default', 'PORT=8090\nSERVICE_MODE="ok"junk\n'],
    ['malformed declaration', 'PORT=8090\nSERVICE_MODE\n']
  ]) {
    fs.writeFileSync(envPath, stagedExample);
    git('add', '--', 'zbrowse/.env.example');
    fs.writeFileSync(envPath, safeExample);
    const result = runScanner();
    assert.equal(result.status, 1,
      label + ': a bad staged example must fail with clean worktree bytes');
    assert.ok(result.stderr.includes('staged index example'),
      label + ': failure must identify the index-policy evidence source');
    assert.equal((result.stdout + result.stderr).includes('qa-placeholder'), false,
      label + ': test output must not include sample field values');
  }
  // Inverse: a valid staged example cannot conceal an unsafe unstaged
  // worktree modification. Restore both copies before successful recovery.
  fs.writeFileSync(envPath, safeExample);
  git('add', '--', 'zbrowse/.env.example');
  fs.writeFileSync(envPath,
    '  # indented comment is safe\nexport SERVICE_PASSWORD =qa-placeholder\n');
  const worktreePolicy = runScanner();
  assert.equal(worktreePolicy.status, 1,
    'credential-bearing worktree env example must fail despite safe index');
  assert.ok(worktreePolicy.stderr.includes('worktree example'),
    'error must identify the active worktree policy');
  fs.writeFileSync(envPath, safeExample);
  // Optional export prefixes, harmless leading comments, and whitespace
  // around benign assignment delimiters are supported without false alarms.
  const harmlessExample = '  # optional config\nexport PUBLIC_MODE = "enabled#ok" # note\nPORT = 8090 # default\n';
  fs.writeFileSync(envPath, harmlessExample);
  git('add', '--', 'zbrowse/.env.example');
  accept('harmless comments and nonsecret spaced/export assignments');
  fs.writeFileSync(envPath, safeExample);
  git('add', '--', 'zbrowse/.env.example');
  accept('safe binary and both clean example-config representations after recovery');
  console.log('Git-index secret-scan integration passed: safe binary, ' +
    'twelve rejected binary/UTF-16/UTF-32/private-key tracked secrets, committed-baseline staged/worktree and hostile-index-path checks, benign public headers, and recovery');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
