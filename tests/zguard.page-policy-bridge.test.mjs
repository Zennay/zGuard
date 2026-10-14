// Integration of the two *shipped* world-specific scripts using a shared DOM
// bus and separate JavaScript global objects. This is not a substitute for
// mandatory pinned real-Chromium MAIN-world browser acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const pageScript = read('../chromium/page-interceptor.js');
const isolatedScript = read('../chromium/content.js');

const listeners = new Map();
const doc = {
  addEventListener(name, callback) {
    const existing = listeners.get(name) || [];
    existing.push(callback);
    listeners.set(name, existing);
  },
  dispatchEvent(event) {
    for (const listener of listeners.get(event.type) || []) listener(event);
    return true;
  }
};
class PolicyEvent {
  constructor(type, init) { this.type = type; this.detail = init.detail; }
}
const location = { href: 'https://origin.test/watch', origin: 'https://origin.test' };
const nativeCalls = [];
const mainWindow = {
  open(url) { nativeCalls.push(url); return { allowed: true }; }
};
vm.runInNewContext(pageScript, {
  URL, document: doc, location, window: mainWindow
}, { filename: 'chromium/page-interceptor.js', timeout: 1000 });

const contentWindow = {
  open(url) { return { original: url }; }
};
const sent = [];
const stored = { enabled: true, mode: 'balanced' };
const observers = [];
const api = {
  runtime: { sendMessage(message) { sent.push(message); } },
  storage: {
    onChanged: { addListener(handler) { observers.push(handler); } },
    local: {
      get(defaults, callback) { callback({ ...defaults, ...stored }); },
      set(changes) {
        const diff = Object.fromEntries(Object.entries(changes).map(([name,value]) =>
          [name, { oldValue: stored[name], newValue: value }]));
        Object.assign(stored, changes);
        for (const listener of observers) listener(diff, 'local');
      }
    }
  }
};
vm.runInNewContext(isolatedScript, {
  URL, document: doc, location, window: contentWindow, chrome: api,
  CustomEvent: PolicyEvent
}, { filename: 'chromium/content.js', timeout: 1000 });
await Promise.resolve();
await Promise.resolve();

assert.equal(observers.length, 1,
  'isolated content must register one live storage observer');
assert.equal(mainWindow.open.name, 'zGuardWindowOpen');
assert.equal(mainWindow.open('https://ads.al5sm.com/popup'), null,
  'balanced MAIN world must block known hostile destinations');
assert.ok(mainWindow.open('https://ordinary.example/video')?.allowed,
  'balanced MAIN world must preserve ordinary external opening');
api.storage.local.set({ mode: 'strict' });
assert.equal(mainWindow.open('https://ordinary.example/video'), null,
  'isolated strict update must reach existing MAIN-world interceptor');
api.storage.local.set({ enabled: false });
assert.ok(mainWindow.open('https://ads.al5sm.com/popup')?.allowed,
  'isolated disable update must reach existing MAIN-world interceptor');
api.storage.local.set({ enabled: true, mode: 'balanced' });
assert.equal(mainWindow.open('https://ads.al5sm.com/popup'), null,
  're-enabling policy must immediately restore blocked host behavior');
assert.ok(mainWindow.open('https://ordinary.example/video')?.allowed,
  're-enabled balanced policy must preserve harmless external opening');

const priorMessages = sent.length;
doc.dispatchEvent(new PolicyEvent('zguard:policy-v1',
  { detail: JSON.stringify({enabled:false,mode:'strict'}) }));
assert.equal(sent.length, priorMessages,
  'forged page-policy events must never invoke privileged runtime messaging');
assert.equal(listeners.get('zguard:policy-v1')?.length, 1,
  'isolated privilege-bearing context must not subscribe to page policy input');
console.log('Shipped MAIN + ISOLATED policy bridge behavior passed without privileged page API');
