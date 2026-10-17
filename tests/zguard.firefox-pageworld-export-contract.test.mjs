// Source-executing, capability-isolated Firefox MV2 page-world acceptance.
// This complements (never replaces) the real geckodriver MAIN-world test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../firefox/content.js', import.meta.url), 'utf8');

function launch({ exporter = true } = {}) {
  const actualOpens = [];
  const sends = [];
  let changes;
  const nativeOpen = function nativeOpen(url, target, features) {
    actualOpens.push({ url, target, features, context: this });
    return { opened: true };
  };
  const page = {};
  const window = { open: nativeOpen, wrappedJSObject: page };
  const docListeners = new Map();
  const context = {
    window,
    document: { addEventListener(type, listener) { docListeners.set(type, listener); } },
    location: { href: 'https://safe.example/index', origin: 'https://safe.example' },
    URL,
    browser: {
      runtime: { sendMessage(message) { sends.push(message); } },
      storage: {
        onChanged: { addListener(fn) { changes = fn; } },
        local: { get() { return Promise.resolve({ enabled: true, mode: 'balanced' }); } }
      }
    }
  };
  if (exporter) {
    context.exportFunction = (fn, target, options) => {
      assert.equal(target, page, 'export only to unwrapped document page');
      assert.deepEqual({ ...options }, { defineAs: 'open' });
      target[options.defineAs] = fn;
      return fn;
    };
  }
  vm.runInNewContext(source, context, { filename: 'firefox/content.js', timeout: 2000 });
  return { page, window, actualOpens, sends, get changes() { return changes; } };
}

const app = launch();
assert.equal(typeof app.page.open, 'function', 'MAIN-world must receive a callable popup guard');
assert.equal(app.page.open.name, 'zGuardWindowOpen', 'native acceptance requires named page guard');
assert.equal(typeof app.changes, 'function', 'keep privileged settings handling isolated');
assert.equal(app.page.open('https://sub.al5sm.com/popup', '_blank'), null,
  'default balanced policy must stop a known hostile popup');
assert.equal(app.actualOpens.length, 0);
assert.ok(app.page.open('https://ordinary.example/video', '_blank'),
  'balanced must allow ordinary cross-site popup');
assert.equal(app.actualOpens.length, 1);
assert.equal(app.actualOpens[0].context, app.window, 'delegate only to captured native window');
app.changes({ mode: { newValue: 'strict' } }, 'local');
assert.equal(app.page.open('https://ordinary.example/video', '_blank'), null,
  'strict must block cross-site page-authored popups');
assert.ok(app.page.open('/same-origin', '_blank'),
  'strict must allow same-origin native browsing context');
app.changes({ enabled: { newValue: false } }, 'local');
assert.ok(app.page.open('https://sub.al5sm.com/popup', '_blank'),
  'disabled must release hostile popup policy on existing page');
assert.equal(app.sends.length, 0,
  'page callback must never forward attacker-controlled commands to extension runtime');
assert.equal(app.page.storage, undefined, 'privileged extension storage must not leak to page');
assert.equal(app.page.runtime, undefined, 'privileged runtime API must not leak to page');
app.changes({ enabled: { newValue: 'invalid' }, mode: { newValue: 'invalid' } }, 'local');
assert.ok(app.page.open('https://ordinary.example/video', '_blank'),
  'untrusted invalid change must not corrupt last reviewed disabled state');

const isolated = launch({ exporter: false });
assert.equal(isolated.page.open, undefined,
  'absence of Firefox exportFunction must not falsely advertise page-world protection');
assert.equal(typeof isolated.window.open, 'function',
  'legacy isolated fallback remains functional for older Firefox');

console.log('Firefox page-world Xray exporter: policy, live settings and privilege isolation PASS');
