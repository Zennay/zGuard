// Issue #302: execute the shipped kiosk launch shell with isolated command
// shims. This proves CLI argument/URL handoff only, NOT MV3 injection timing,
// sandbox effectiveness, Docker confinement or real VPS cold-start safety.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceFile = new URL('../zbrowse/browser/root/usr/local/bin/start-zbrowse', import.meta.url);
const shipped = fs.readFileSync(sourceFile, 'utf8');
const coldStart = fs.readFileSync(
  new URL('./zguard.chromium-real-browser.test.mjs', import.meta.url), 'utf8');
const workflow = fs.readFileSync(
  new URL('../.github/workflows/zguard-real-chromium-acceptance.yml', import.meta.url),
  'utf8');
const command = 'node tests/zbrowse.launch-cli-contract.test.mjs';
const proofAt = workflow.indexOf(command);
const realBrowserAt = workflow.indexOf('node tests/zguard.chromium-real-browser.test.mjs');
assert.ok(proofAt > 0 && realBrowserAt > proofAt,
  'real kiosk shell contract must execute before hosted Chromium acceptance');
assert.ok(coldStart.includes("const variants = ['chromium', 'zbrowse/browser/zguard'];"),
  'browser QA must retain both installed zGuard variants');
assert.ok(coldStart.includes("'--remote-debugging-port=0', coldStart ? url : 'about:blank'"),
  'strict cold start must navigate directly on Chromium command line');
assert.ok(coldStart.includes('fs.mkdtempSync(path.join(os.tmpdir(), \'zguard-chromium-\'))'),
  'strict cold-start browser runs must use fresh profiles');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zbrowse-launch-qa-'));
const fakePath = path.join(directory, 'bin');
fs.mkdirSync(fakePath);
const capture = path.join(directory, 'browser-args');
const browserCalls = path.join(directory, 'browser-calls');
const mkdirCalls = path.join(directory, 'mkdir-calls');
const mkdirCapture = path.join(directory, 'mkdir-args');
function shim(name, script) {
  const filename = path.join(fakePath, name);
  fs.writeFileSync(filename, '#!/bin/sh\n' + script + '\n', { mode: 0o700 });
}
// These shims keep the production launcher from touching /config or running
// Chromium; only the shell's actual argument construction gets executed.
shim('mkdir', 'printf "call\n" >> "$CAPTURE_MKDIR_CALLS"; printf "%s\n" "$@" > "$CAPTURE_MKDIR"');
shim('chromium', 'printf "call\n" >> "$CAPTURE_BROWSER_CALLS"; printf "%s\n" "$@" > "$CAPTURE_ARGS"');

function run(launcher, startUrl) {
  fs.rmSync(capture, { force: true });
  fs.rmSync(mkdirCapture, { force: true });
  fs.rmSync(browserCalls, { force: true });
  fs.rmSync(mkdirCalls, { force: true });
  const env = {
    PATH: fakePath + ':/usr/bin:/bin',
    CAPTURE_ARGS: capture, CAPTURE_MKDIR: mkdirCapture,
    CAPTURE_BROWSER_CALLS: browserCalls, CAPTURE_MKDIR_CALLS: mkdirCalls
  };
  if (startUrl !== undefined) env.START_URL = startUrl;
  const child = spawnSync('/bin/bash', [launcher], {
    env, encoding: 'utf8', timeout: 4000
  });
  assert.equal(child.status, 0,
    'shipped kiosk shell must execute without bypassing command shims: ' +
    (child.stderr || '').slice(0, 400));
  assert.ok(fs.existsSync(capture), 'Chromium launch must reach the shim');
  assert.equal(fs.readFileSync(browserCalls, 'utf8'), 'call\\n',
    'the actual shell may launch Chromium exactly once');
  assert.equal(fs.readFileSync(mkdirCalls, 'utf8'), 'call\\n',
    'the shell may prepare directories exactly once');
  const args = fs.readFileSync(capture, 'utf8').trimEnd().split('\n');
  const mkdirArgs = fs.readFileSync(mkdirCapture, 'utf8').trimEnd().split('\n');
  assert.deepEqual(mkdirArgs, ['-p', '/config/chromium', '/config/downloads', '/config/tmp'],
    'kiosk must prepare private config/download/temp locations');
  return args;
}

function verify(args, expectedUrl) {
  const one = value => {
    assert.equal(args.filter(arg => arg === value).length, 1,
      value + ': startup argument must occur exactly once');
    return args.indexOf(value);
  };
  const only = name => {
    assert.equal(args.filter(arg => arg.startsWith(name)).length, 1,
      name + ': startup must use exactly one reviewed flag');
  };
  const exception = one('--disable-extensions-except=/opt/zguard');
  const injection = one('--load-extension=/opt/zguard');
  const profile = one('--user-data-dir=/config/chromium');
  const cache = one('--disk-cache-dir=/config/tmp');
  const kiosk = one('--kiosk');
  one('--no-first-run');
  one('--no-default-browser-check');
  only('--disable-extensions-except=');
  only('--load-extension=');
  only('--user-data-dir=');
  only('--disk-cache-dir=');
  assert.ok(exception < injection && injection < kiosk && kiosk < args.length - 1,
    'extension setup and kiosk mode must be supplied before CLI navigation');
  assert.ok(profile < args.length - 1 && cache < args.length - 1,
    'private profile/cache paths must be fixed before the start URL');
  assert.equal(args.at(-1), expectedUrl,
    'one original reviewed start URL must be passed as the final argument');
  assert.equal(args.filter(arg => /^https?:\/\//i.test(arg)).length, 1,
    'must not navigate or preload any extra URL before kiosk start');
  for (const unreviewed of [
    '--disable-web-security', '--ignore-certificate-errors',
    '--remote-debugging-port', '--remote-debugging-address',
    '--allow-file-access-from-files', '--proxy-server'
  ]) {
    assert.equal(args.some(arg => arg.startsWith(unreviewed)), false,
      'QA forbids newly introduced dangerous startup flag ' + unreviewed);
  }
  // Production currently includes --no-sandbox (issue #16). Do NOT treat
  // this command-line parity result as an endorsement of sandboxing.
}

try {
  for (const [name, url] of [
    ['default', undefined],
    ['explicit curated origin', 'https://approved.invalid/series?lang=en&v=2'],
    ['empty fallback', '']
  ]) {
    const args = run(sourceFile.pathname, url);
    const expected = url || 'https://fawesome.tv/';
    verify(args, expected);
    assert.equal(args.filter(arg => arg.startsWith('--load-extension=')).length, 1,
      name + ': duplicated extension startup is not reviewed');
  }

  // The checks must reject concrete drift in the *executed* launch script,
  // not merely confirm string presence in source comments.
  let mutations = 0;
  for (const [label, before, after] of [
    ['extension directory changed', '--load-extension=/opt/zguard',
      '--load-extension=/tmp/unreviewed'],
    ['extension allowlist changed', '--disable-extensions-except=/opt/zguard',
      '--disable-extensions-except=/tmp/unreviewed'],
    ['removed kiosk', '--kiosk', '--start-maximized'],
    ['shared browser profile', '--user-data-dir=/config/chromium',
      '--user-data-dir=/tmp/unsafe'],
    ['early URL launch', '"$start_url"', '"https://unknown.invalid/" "$start_url"'],
    ['unsafe extra debug socket', '--disable-background-networking',
      '--remote-debugging-port=9222 --disable-background-networking']
  ]) {
    assert.ok(shipped.includes(before), label + ': fixture anchor must exist');
    const mutated = shipped.replace(before, after);
    assert.notEqual(mutated, shipped, 'mutation must change launched script');
    const badFile = path.join(directory, 'mutated-start.sh');
    fs.writeFileSync(badFile, mutated, { mode: 0o700 });
    assert.throws(() => {
      const args = run(badFile, 'https://approved.invalid/');
      verify(args, 'https://approved.invalid/');
    }, undefined, label + ': unsafe actual CLI must fail the QA contract');
    mutations++;
  }
  console.log('kiosk command-line cold-start contract passed: 3 genuine shell ' +
    'launches, 6 rejected real-shell mutations; actual MV3 timing remains #302');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
