const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.textContent = '';
    this.checked = false;
    this.disabled = false;
    this.active = false;
    this.off = false;
    this.listeners = new Map();
    this.classList = {
      toggle: (name, value) => {
        if (name === 'active') this.active = Boolean(value);
        if (name === 'off') this.off = Boolean(value);
      }
    };
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  fire(type) { return this.listeners.get(type)?.(); }
}

async function openPopup(relative, tabUrl, options = {}) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const enabled = new Element();
  const count = new Element();
  const site = new Element();
  const status = new Element();
  const balanced = new Element({ mode: 'balanced' });
  const strict = new Element({ mode: 'strict' });
  const settings = { enabled: true, mode: 'balanced', blockedCount: 4 };
  const document = {
    querySelector: (selector) => ({
      '#enabled': enabled, '#count': count, '#site': site, '#status': status
    })[selector],
    querySelectorAll: (selector) => selector === '[data-mode]' ? [balanced, strict] : []
  };
  const api = { runtime: {}, tabs: {} };
  function result(message) {
    if (message.type === 'get-settings') {
      if (options.failRead) return undefined;
      if (options.corruptRead) return { enabled: 'not a boolean', mode: 'strict', blockedCount: 4 };
      return { ...settings };
    }
    if (message.type === 'set-settings') {
      if (options.failSave) return undefined;
      Object.assign(settings, message.settings);
      return { ...settings };
    }
    throw new Error('unexpected popup message ' + message.type);
  }
  if (relative.startsWith('firefox/')) {
    api.runtime.sendMessage = (message) => options.rejectRead && message.type === 'get-settings'
      ? Promise.reject(new Error('storage unavailable')) : Promise.resolve(result(message));
    api.tabs.query = async () => [{ url: tabUrl }];
  } else {
    api.runtime.sendMessage = (message, callback) => callback(result(message));
    api.tabs.query = (_query, callback) => callback([{ url: tabUrl }]);
  }
  const context = { URL, document, console };
  if (relative.startsWith('firefox/')) context.browser = api;
  else context.chrome = api;
  vm.runInNewContext(source, context, { filename: relative });
  await new Promise((resolve) => setImmediate(resolve));
  return { enabled, count, site, status, balanced, strict, settings };
}

async function verify(relative) {
  const view = await openPopup(relative, 'https://example.org/watch');
  assert.equal(view.site.textContent, 'example.org', relative + ': tab hostname visible');
  assert.equal(view.enabled.checked, true);
  assert.equal(view.enabled.disabled, false);
  assert.equal(view.count.textContent, '4');
  assert.equal(view.status.textContent, 'Actief');
  assert.equal(view.balanced.active, true);
  assert.equal(view.strict.active, false);
  view.enabled.checked = false;
  await view.enabled.fire('change');
  assert.equal(view.settings.enabled, false, relative + ': toggle saved via background message');
  assert.equal(view.status.textContent, 'Uitgeschakeld');
  await view.strict.fire('click');
  assert.equal(view.settings.mode, 'strict');
  assert.equal(view.strict.active, true);
  assert.equal(view.balanced.active, false);

  for (const tab of ['about:blank', 'not a URL', '', 'chrome://settings']) {
    const internal = await openPopup(relative, tab);
    assert.equal(internal.site.textContent, 'Deze site',
      relative + ': invalid/internal hostname must show a readable fallback');
  }

  const saveFailure = await openPopup(relative, 'https://example.org', { failSave: true });
  saveFailure.enabled.checked = false;
  await saveFailure.enabled.fire('change');
  assert.equal(saveFailure.settings.enabled, true, relative + ': rejected toggle not persisted');
  assert.equal(saveFailure.enabled.checked, true, relative + ': rejected toggle must revert visibly');
  assert.equal(saveFailure.status.textContent, 'Opslaan mislukt');
  assert.equal(saveFailure.status.off, true);
  const corrupt = await openPopup(relative, 'https://example.org', { corruptRead: true });
  assert.equal(corrupt.enabled.disabled, true, relative + ': corrupt settings fail closed');
  assert.equal(corrupt.strict.disabled, true);
  assert.equal(corrupt.status.textContent, 'Instellingen niet beschikbaar');
  const missing = await openPopup(relative, 'https://example.org', { failRead: true });
  assert.equal(missing.enabled.disabled, true, relative + ': empty storage response disables controls');
  assert.equal(missing.status.textContent, 'Instellingen niet beschikbaar');
}

(async () => {
  await verify('chromium/popup.js');
  await verify('firefox/popup.js');
  await verify('zbrowse/browser/zguard/popup.js');
  const failed = await openPopup('firefox/popup.js', 'about:blank', { rejectRead: true });
  assert.equal(failed.enabled.disabled, true, 'rejected Firefox storage read fails closed');
  console.log('zGuard popup settings and failure-state runtime tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
