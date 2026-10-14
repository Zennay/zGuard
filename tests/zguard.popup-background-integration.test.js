const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.checked = false;
    this.disabled = false;
    this.textContent = '';
    this.active = false;
    this.listeners = new Map();
    this.classList = {
      toggle: (name, value) => {
        if (name === 'active') this.active = Boolean(value);
      }
    };
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  trigger(name) { return this.listeners.get(name)?.(); }
}

async function check(packagePath) {
  const firefox = packagePath === 'firefox';
  const read = (name) => fs.readFileSync(path.join(root, packagePath, name), 'utf8');
  const stored = { enabled: true, mode: 'balanced', blockedCount: 0, lastBlocked: null };
  const removed = [];
  let onMessage;
  let onCreated;
  let onUpdated;
  let onRemoved;
  const storage = {
    get(defaults, callback) {
      return new Promise((resolve) => setTimeout(() => {
        const value = { ...defaults, ...stored };
        if (callback) callback(value);
        resolve(value);
      }, 2));
    },
    set(patch, callback) {
      return new Promise((resolve) => setTimeout(() => {
        Object.assign(stored, patch);
        if (callback) callback();
        resolve();
      }, 2));
    }
  };
  const background = {
    storage: { local: storage },
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener(handler) { onMessage = handler; } }
    },
    tabs: {
      onCreated: { addListener(handler) { onCreated = handler; } },
      onUpdated: { addListener(handler) { onUpdated = handler; } },
      onRemoved: { addListener(handler) { onRemoved = handler; } },
      get: async () => ({ url: 'https://origin.test/home' }),
      remove: async (id) => { removed.push(id); }
    }
  };
  const backgroundContext = { URL, console };
  backgroundContext[firefox ? 'browser' : 'chrome'] = background;
  vm.runInNewContext(read('background.js'), backgroundContext);
  assert.equal(typeof onMessage, 'function');
  assert.equal(typeof onCreated, 'function');
  assert.equal(typeof onUpdated, 'function');
  assert.equal(typeof onRemoved, 'function');

  function message(input) {
    return new Promise((resolve, reject) => {
      const result = onMessage(input, {}, resolve);
      if (result && typeof result.then === 'function') result.then(resolve, reject);
      else if (result === false) resolve(undefined);
    });
  }

  async function popup() {
    const enabled = new Element();
    const count = new Element();
    const site = new Element();
    const status = new Element();
    const balanced = new Element({ mode: 'balanced' });
    const strict = new Element({ mode: 'strict' });
    const document = {
      querySelector: (id) => ({
        '#enabled': enabled, '#count': count, '#site': site, '#status': status
      })[id],
      querySelectorAll: () => [balanced, strict]
    };
    const runtime = {
      sendMessage: firefox ? message : (input, callback) => {
        const result = onMessage(input, {}, callback);
        if (result && typeof result.then === 'function') result.then(callback);
      }
    };
    const tabs = firefox
      ? { query: async () => [{ url: 'https://origin.test/home' }] }
      : { query: (_query, callback) => callback([{ url: 'https://origin.test/home' }]) };
    const context = { URL, console, document };
    context[firefox ? 'browser' : 'chrome'] = { runtime, tabs };
    vm.runInNewContext(read('popup.js'), context);
    for (let i = 0; i < 50 && !['Actief', 'Uitgeschakeld'].includes(status.textContent); i++) {
      await sleep(5);
    }
    assert.ok(['Actief', 'Uitgeschakeld'].includes(status.textContent),
      packagePath + ': actual background must hydrate popup');
    return { enabled, count, site, status, balanced, strict };
  }

  const ui = await popup();
  assert.equal(ui.site.textContent, 'origin.test');
  assert.equal(ui.count.textContent, '0');
  assert.equal(ui.enabled.checked, true);

  ui.enabled.checked = false;
  await Promise.all([ui.enabled.trigger('change'), ui.strict.trigger('click')]);
  const saved = await message({ type: 'get-settings' });
  assert.equal(saved.enabled, false, packagePath + ': disabled persisted');
  assert.equal(saved.mode, 'strict', packagePath + ': strict mode persisted');
  assert.equal(ui.strict.active, true);
  await onCreated({ id: 50, openerTabId: 1, pendingUrl: 'https://ads.al5sm.com/popup' });
  assert.deepEqual(removed, [], packagePath + ': disabled mode must not remove tabs');
  ui.enabled.checked = true;
  await ui.enabled.trigger('change');
  await onCreated({
    id: 51, openerTabId: 1, url: '',
    pendingUrl: 'https://user:secret@ads.al5sm.com/popup?token=private'
  });
  assert.deepEqual(removed, [51], packagePath + ': enabled popup guard must remove hostile pending tab');
  // A browser that creates about:blank before publishing a hostile web
  // destination must still be blocked by the real background listener.
  await onCreated({ id: 52, openerTabId: 1, url: 'about:blank' });
  await onUpdated(52, { status: 'loading' }, {});
  await onUpdated(52, { url: 'https://ads.al5sm.com/late?credential=private' }, {});
  assert.deepEqual(removed, [51, 52],
    packagePath + ': delayed hostile popup navigation must close exactly once');
  onRemoved(52);
  await onUpdated(52, { url: 'https://ads.al5sm.com/again' }, {});
  assert.deepEqual(removed, [51, 52],
    packagePath + ': removed tab must clear the delayed-navigation record');
  const after = await message({ type: 'get-settings' });
  assert.equal(after.blockedCount, 2);
  assert.equal(after.lastBlocked.detail.url, 'https://ads.al5sm.com');
  const refreshed = await popup();
  assert.equal(refreshed.count.textContent, '2',
    packagePath + ': popup should read real persisted blocked count');
  assert.equal(refreshed.strict.active, true);
  assert.equal(refreshed.enabled.checked, true);
}

(async () => {
  for (const name of ['chromium', 'firefox', 'zbrowse/browser/zguard']) await check(name);
  console.log('zGuard popup-to-background runtime integration passed for all packages');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
