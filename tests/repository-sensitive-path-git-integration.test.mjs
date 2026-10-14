// End-to-end Git-index path QA. Only synthetic files in a temporary Git repo:
// no VPS, production secrets, sessions or external network calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const scannerPath = new URL('./repository-sensitive-path-hygiene.test.mjs', import.meta.url);
const reviewed = fs.readFileSync(scannerPath, 'utf8');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zguard-path-qa-'));
const script = path.join(scratch, 'tests', 'repository-sensitive-path-hygiene.test.mjs');
const cwd = scratch;
function git(...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
}
function run() {
  return spawnSync(process.execPath, [script], {
    cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024
  });
}
function stage(relative) {
  const absolute = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, 'synthetic nonsecret fixture\n');
  git('add', '--', relative);
}
try {
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, reviewed);
  git('init', '-q');
  stage('.env.example');
  stage('docs/readme.txt');
  let result = run();
  assert.equal(result.status, 0, 'approved templates and ordinary files must pass');
  assert.match(result.stdout, /sensitive-path hygiene contract passed/);

  const hostileEnv = '.ENV.LOCAL\nFORGED QA SUCCESS\x1b[2J';
  const hostileSsh = 'docs/.SSH/id_ed25519';
  const hostileBidi = 'keys/secret\u202e.P12';
  for (const [name, expected] of [
    [hostileEnv, /tracked environment file/],
    [hostileSsh, /tracked SSH material/],
    [hostileBidi, /tracked private-key\/keystore path/]
  ]) {
    stage(name);
    result = run();
    assert.equal(result.status, 1,
      'a forbidden Git-index path must fail, even if it is staged only');
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr,
      /[\x1b\u202a-\u202e\u2066-\u2069]/u,
      'the exact scanner must not write raw ANSI or bidi controls into CI stderr');
    assert.ok(!result.stderr.includes('\nFORGED QA SUCCESS'),
      'raw injected lines must not be emitted to CI diagnostics');
    assert.ok(result.stderr.includes(JSON.stringify(name).slice(1, -1)
      .replace(/\u202e/g, '\\u202e')) || name === hostileSsh,
      'safe diagnostic must retain a visible escaped name for the reviewer');
    git('rm', '-q', '--cached', '--', name);
    fs.rmSync(path.join(cwd, name));
  }
  assert.equal(run().status, 0,
    'clean Git index must pass again after staged forbidden paths are removed');

  // Mutation control: if the diagnostic reverts to interpolating the raw
  // filename, the same real Git-index fixture must expose the regression.
  assert.ok(reviewed.includes('${escapeDiagnosticPath(relative)}'),
    'reviewed scanner must use the shared escaping function for findings');
  const weakened = reviewed.replaceAll(
    '${escapeDiagnosticPath(relative)}', '${relative}'
  );
  assert.notEqual(weakened, reviewed, 'negative mutation must change the checker');
  stage(hostileEnv);
  fs.writeFileSync(script, weakened);
  const bypass = run();
  assert.equal(bypass.status, 1,
    'unescaped checker still detects forbidden name but must leak raw controls');
  assert.ok(bypass.stderr.includes('\nFORGED QA SUCCESS') ||
    bypass.stderr.includes('\x1b'),
    'negative mutation must demonstrably re-introduce raw log injection');
  fs.writeFileSync(script, reviewed);
  result = run();
  assert.equal(result.status, 1, 'restored checker must still deny unsafe path');
  assert.ok(!result.stderr.includes('\nFORGED QA SUCCESS') &&
    !result.stderr.includes('\x1b'),
    'restored checker must again provide safe one-line diagnostics');
  console.log('Git-index sensitive paths: staged casefold, ANSI, newline, bidi, ' +
    'SSH and private-key boundaries PASS; raw-log mutation rejected');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
