// Read-only contract for shipped zBrowse Chromium launch (not VPS sandbox proof).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-browser-sandbox');

function chromiumOptions(script) {
  const lines = script.split(/\r?\n/);
  const entries = lines.map((line, index) => (/^\s*exec\s+chromium(?:\s|$)/.test(line) ? index : -1))
    .filter(index => index >= 0);
  assert.equal(entries.length, 1, 'exactly one explicit Chromium exec is required');
  const parts = [];
  for (let i = entries[0]; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    const raw = i === entries[0] ? trimmed.replace(/^exec\s+chromium\s*/, '') : trimmed;
    const continued = raw.endsWith(String.fromCharCode(92));
    parts.push(continued ? raw.slice(0, -1).trim() : raw);
    if (!continued) break;
    assert.ok(i + 1 < lines.length, 'Chromium continuation must not end at EOF');
  }
  const words = parts.join(' ').trim().split(/\s+/).filter(Boolean);
  assert.equal(words.pop(), '"$start_url"', 'Chromium must end in the approved target URL');
  assert.ok(words.length > 0, 'explicit Chromium options are required');
  for (const arg of words) {
    assert.match(arg, /^--[a-z][a-z0-9-]*(?:=[A-Za-z0-9_,./:-]+)?$/,
      'Chromium options must be literal, reviewable switches without shell expansion');
  }
  return words;
}
// Reject alternate Chromium isolation escape hatches, not just --no-sandbox.
// --disable-features takes a comma-separated list: allowing one safe feature
// must not conceal an unsafe feature later in the same literal argument.
function sandboxWeakening(args) {
  const dangerousSwitch = /^(?:--no-sandbox|--no-zygote|--single-process|--in-process-gpu|--disable-(?:setuid|seccomp-filter|namespace|gpu)-sandbox|--disable-site-isolation-trials|--disable-web-security)(?:=|$)/;
  const dangerousFeatures = new Set([
    'isolateorigins', 'siteperprocess', 'site-per-process',
    'strictoriginisolation', 'origin-keyed-processes-by-default'
  ]);
  return args.filter(arg => {
    if (dangerousSwitch.test(arg)) return true;
    if (!arg.startsWith('--disable-features=')) return false;
    return arg.slice('--disable-features='.length).split(',')
      .some(feature => dangerousFeatures.has(feature.trim().toLowerCase()));
  });
}
const slash = String.fromCharCode(92);
const fixture = options => ['exec chromium ' + slash,
  ...options.map(option => '  ' + option + ' ' + slash),
  '  "$start_url"'].join('\n');
assert.deepEqual(chromiumOptions('# --no-sandbox\n' + fixture(['--kiosk'])), ['--kiosk']);
assert.deepEqual(sandboxWeakening(chromiumOptions(fixture(['--no-sandbox']))), ['--no-sandbox']);
assert.deepEqual(sandboxWeakening(chromiumOptions(fixture(['--disable-setuid-sandbox']))),
  ['--disable-setuid-sandbox']);
// Negative fixtures must exercise every bypass without claiming that a
// baseline source inspection is runtime evidence of active kernel sandboxing.
for (const arg of [
  '--disable-seccomp-filter-sandbox', '--disable-namespace-sandbox',
  '--disable-gpu-sandbox', '--no-zygote', '--single-process',
  '--in-process-gpu', '--disable-site-isolation-trials',
  '--disable-web-security', '--disable-features=IsolateOrigins',
  '--disable-features=TranslateUI,SitePerProcess,MediaRouter',
  '--disable-features=StrictOriginIsolation',
  '--disable-features=origin-keyed-processes-by-default'
]) {
  assert.deepEqual(sandboxWeakening(chromiumOptions(fixture(['--kiosk', arg]))), [arg],
    'unreviewed browser isolation weakening must be rejected: ' + arg);
}
assert.deepEqual(sandboxWeakening(chromiumOptions(fixture([
  '--disable-features=TranslateUI,MediaRouter', '--disable-dev-shm-usage'
]))), [], 'reviewed non-isolation feature flags must remain allowed');
assert.deepEqual(sandboxWeakening(chromiumOptions(fixture([
  '--disable-features=NotIsolateOrigins,FakeSitePerProcess'
]))), [], 'partial feature-name matches must not create false alarms');
assert.throws(() => chromiumOptions('exec chromium "$FLAGS" "$start_url"'),
  /literal, reviewable/);
assert.throws(() => chromiumOptions(fixture([]) + '\n' + fixture([])),
  /exactly one/);

const source = fs.readFileSync(
  new URL('../zbrowse/browser/root/usr/local/bin/start-zbrowse', import.meta.url), 'utf8');
const activeFlags = sandboxWeakening(chromiumOptions(source));
assert.deepEqual(activeFlags.filter(flag => flag !== '--no-sandbox'), [],
  'new unreviewed Chromium sandbox-disabling flags are forbidden even in baseline');
if (strict) {
  assert.deepEqual(activeFlags, [],
    'shipped Chromium must not disable its process sandbox (issue #16)');
  console.log('Chromium source sandbox flags PASS; real VPS image proof still required');
} else {
  console.log('Chromium process-sandbox source posture: disabled=' +
    activeFlags.includes('--no-sandbox') +
    '; strict proof requires --require-browser-sandbox; no real VPS claim');
}
