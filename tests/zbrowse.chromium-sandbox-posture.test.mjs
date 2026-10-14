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
function sandboxWeakening(args) {
  return args.filter(arg =>
    /^(?:--no-sandbox|--disable-(?:setuid|seccomp-filter|namespace)-sandbox)(?:=|$)/.test(arg));
}
const slash = String.fromCharCode(92);
const fixture = options => ['exec chromium ' + slash,
  ...options.map(option => '  ' + option + ' ' + slash),
  '  "$start_url"'].join('\n');
assert.deepEqual(chromiumOptions('# --no-sandbox\n' + fixture(['--kiosk'])), ['--kiosk']);
assert.deepEqual(sandboxWeakening(chromiumOptions(fixture(['--no-sandbox']))), ['--no-sandbox']);
assert.deepEqual(sandboxWeakening(chromiumOptions(fixture(['--disable-setuid-sandbox']))),
  ['--disable-setuid-sandbox']);
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
