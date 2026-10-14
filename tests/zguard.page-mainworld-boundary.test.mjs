// Source-executing unprivileged MAIN-world acceptance. Real MV3 page-world
// proof runs independently in the dedicated pinned Chromium workflow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const chromium = fs.readFileSync(new URL('../chromium/page-interceptor.js', import.meta.url), 'utf8');
const bundled = fs.readFileSync(new URL('../zbrowse/browser/zguard/page-interceptor.js', import.meta.url), 'utf8');
assert.equal(bundled, chromium, 'embedded zBrowse page interceptor must remain byte-for-byte identical');

// The MAIN-world filter must never drift from the reviewed hostile-domain
// lists in the privileged fallback and Firefox packages. Otherwise a newly
// blocked popup domain could remain accessible in one injection world.
function extractHostList(source, declaration) {
  const prefix = declaration === 'Set'
    ? /const\\s+(?:blockedHosts|HOSTILE_HOSTS)\\s*=\\s*new Set\\((\\[[^\\]]+\\])\\)/
    : /const\\s+HOSTILE_HOSTS\\s*=\\s*(\\[[^\\]]+\\])/;
  const match = source.match(prefix);
  assert.ok(match, 'reviewed hostile-host declaration must remain inspectable');
  return Array.from(vm.runInNewContext(match[1])).sort();
}
const background = fs.readFileSync(new URL('../chromium/background.js', import.meta.url), 'utf8');
const firefoxBackground = fs.readFileSync(new URL('../firefox/background.js', import.meta.url), 'utf8');
const chromeContent = fs.readFileSync(new URL('../chromium/content.js', import.meta.url), 'utf8');
const firefoxContent = fs.readFileSync(new URL('../firefox/content.js', import.meta.url), 'utf8');
const reviewedHosts = extractHostList(background, 'Array');
function assertPolicyParity(pageSource) {
  const mainHosts = extractHostList(pageSource, 'Set');
  assert.deepEqual(mainHosts, reviewedHosts,
    'page-world hostile hosts must exactly match the browser-level fallback');
  for (const [source, type, name] of [
    [firefoxBackground, 'Array', 'Firefox background'],
    [chromeContent, 'Set', 'Chromium isolated content'],
    [firefoxContent, 'Set', 'Firefox isolated content']
  ]) {
    assert.deepEqual(extractHostList(source, type), reviewedHosts,
      name + ' must use the same reviewed hostile-host list');
  }
}
assertPolicyParity(chromium);
for (const mutation of [
  chromium.replace("'tmll7.com'", "'lookalike.invalid'"),
  chromium.replace(", 'nap5k.com'", '')
]) {
  assert.throws(() => assertPolicyParity(mutation),
    /page-world hostile hosts must exactly match/,
    'removing or swapping any MAIN-world hostile host must fail CI');
}


// MAIN world must never access privileged extension APIs, cookies or network
// transports: page-origin scripts may observe and forge all DOM events.
for (const risky of [
  /\b(?:chrome|browser)\s*\./,
  /\b(?:fetch|XMLHttpRequest|WebSocket|eval)\s*\(/,
  /\b(?:localStorage|sessionStorage|document\.cookie)\b/,
  /\b(?:runtime|scripting|tabs|storage)\s*\.\s*(?:sendMessage|executeScript|remove|set|get)\s*\(/
]) {
  assert.doesNotMatch(chromium, risky,
    'MAIN-world interceptor must have no privileged or network side effects');
}

function boot(source = chromium) {
  const native = [];
  const listeners = new Map();
  const original = function (url, target, features) {
    native.push({ url, target, features });
    return { native: true };
  };
  const page = { open: original };
  const dom = {
    addEventListener(type, callback) {
      const registered = listeners.get(type) || [];
      registered.push(callback);
      listeners.set(type, registered);
    }
  };
  const context = {
    URL,
    document: dom,
    window: page,
    location: { href: 'https://origin.test/page', origin: 'https://origin.test' }
  };
  vm.runInNewContext(source, context, { filename: 'page-interceptor.js', timeout: 1000 });
  assert.equal(page.open.name, 'zGuardWindowOpen',
    'page-visible window.open must be replaced in MAIN world');
  assert.equal(listeners.get('zguard:policy-v1')?.length, 1,
    'page interceptor must register one fixed-schema policy channel');

  return {
    open(url, target = '_blank', features = '') {
      return page.open(url, target, features);
    },
    policy(details) {
      for (const listener of listeners.get('zguard:policy-v1')) {
        listener({ detail: details });
      }
    },
    native
  };
}

const page = boot();
assert.equal(page.open('https://ads.al5sm.com/private?token=hidden'), null,
  'default balanced mode must block known hostile destination');
assert.ok(page.open('https://ordinary.example/video', '_blank', 'noopener')?.native,
  'balanced mode must preserve normal new tabs');
assert.ok(page.open('/same-origin')?.native,
  'same-origin opening must remain available');
assert.equal(page.native.at(-1).url, '/same-origin',
  'native open arguments must not be rewritten');
assert.equal(page.open('https://al5sm.com.attacker.example/')?.native, true,
  'a hostile-domain suffix lookalike must remain safe');
assert.equal(page.open('https://user:pass@WWW.NAP5K.COM./popup'), null,
  'real hostile authority with credentials and root dot must be blocked');
assert.equal(page.open('https://nested.sub.TMLL7.com./popup'), null,
  'nested hostile hostname with root dot must be blocked');

page.policy(JSON.stringify({ enabled: true, mode: 'strict' }));
assert.equal(page.open('https://ordinary.example/'), null,
  'live strict policy must block ordinary external windows');
assert.ok(page.open('https://origin.test/allowed')?.native,
  'strict policy still permits same-origin browsing');

for (const bad of [
  { enabled: false, mode: 'strict', command: 'remove-all-tabs' },
  { enabled: 'false', mode: 'balanced' },
  { enabled: true, mode: 'off' },
  ['false', 'balanced'],
  null
]) {
  page.policy(JSON.stringify(bad));
  assert.equal(page.open('https://ordinary.example/') , null,
    'unreviewed settings payload must not weaken current mode');
}
page.policy('{not-json');
page.policy('x'.repeat(97));
assert.equal(page.open('https://ordinary.example/') , null,
  'malformed/oversize config must be ignored');

page.policy(JSON.stringify({ enabled: false, mode: 'strict' }));
assert.ok(page.open('https://ads.al5sm.com/disabled')?.native,
  'disabled policy must restore original tab-opening behavior');
page.policy(JSON.stringify({ enabled: true, mode: 'balanced' }));
assert.equal(page.open('https://ads.al5sm.com/re-enabled'), null,
  're-enabling must restore hostile domain protection');
assert.ok(page.open('https://ordinary.example/re-enabled')?.native,
  're-enabled balanced mode must preserve harmless external tabs');

const workflow = fs.readFileSync(new URL('../.github/workflows/zguard-real-chromium-acceptance.yml',
  import.meta.url), 'utf8');
assert.match(workflow, /^\s+node tests\/zguard\.page-mainworld-boundary\.test\.mjs\s*$/m,
  'real-browser workflow must execute the page-world security contract');
assert.match(workflow, /^\s+node tests\/zguard\.chromium-real-browser\.test\.mjs --require-mainworld\s*$/m,
  'the real page-world Chrome acceptance must run on every PR and main push');
console.log('Unprivileged MAIN-world policy and real-browser gate contracts passed');
