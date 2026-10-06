const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

class FakeElement {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.checked = false;
    this.textContent = '';
    this.listeners = new Map();
    this.active = false;
    this.classList = {
      toggle: (name, force) => {
        if (name === 'active') this.active = Boolean(force);
      }
    };
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
}

async function loadPopup(relativePath, tabUrl) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const enabled = new FakeElement();
  const count = new FakeElement();
  const site = new FakeElement();
  const status = new FakeElement();
  const balanced = new FakeElement({ mode: 'balanced' });
  const strict = new FakeElement({ mode: 'strict' });
  const settings = { enabled: true, mode: 'balanced', blockedCount: 3, lastBlocked: null };

  const document = {
    querySelector(selector) {
      return {
        '#enabled': enabled,
        '#count': count,
        '#site': site,
        '#status': status
      }[selector];
    },
    querySelectorAll(selector) {
      return selector === '[data-mode]' ? [balanced, strict] : [];
    }
  };

  const api = {
    runtime: {},
    tabs: {}
  };

  if (relativePath.startsWith('firefox/')) {
    api.runtime.sendMessage = async (message) => {
      if (message.type === 'set-settings') Object.assign(settings, message.settings);
      return { ...settings };
    };
    api.tabs.query = async () => [{ url: tabUrl }];
  } else {
    api.runtime.sendMessage = (message, callback) => {
      if (message.type === 'set-settings') Object.assign(settings, message.settings);
      callback({ ...settings });
    };
    api.tabs.query = (_query, callback) => callback([{ url: tabUrl }]);
  }

  const context = { URL, console, document };
  if (relativePath.startsWith('firefox/')) context.browser = api;
  else context.chrome = api;

  vm.runInNewContext(source, context, { filename: relativePath });
  await new Promise((resolve) => setImmediate(resolve));

  return { enabled, count, site, status, balanced, strict };
}

async function verifyBrowser(relativePath) {
  const internal = await loadPopup(relativePath, 'about:blank');
  assert.equal(internal.site.textContent, 'Deze site', `${relativePath}: internal tabs need a readable fallback label`);
  assert.equal(internal.enabled.checked, true);
  assert.equal(internal.count.textContent, '3');
  assert.equal(internal.status.textContent, 'Actief');
  assert.equal(internal.balanced.active, true);
  assert.equal(internal.strict.active, false);

  const web = await loadPopup(relativePath, 'https://example.org/watch');
  assert.equal(web.site.textContent, 'example.org', `${relativePath}: web tabs must show their hostname`);
}

(async () => {
  await verifyBrowser('chromium/popup.js');
  await verifyBrowser('firefox/popup.js');
  console.log('zGuard popup runtime tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
