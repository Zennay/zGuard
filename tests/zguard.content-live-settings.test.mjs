// Exercise the *shipped* content scripts in deterministic extension contexts.
// Strict mode proves settings changed via storage events reach existing tabs.
// This VM test does not claim page MAIN-world interception or real-browser proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['chromium', 'firefox', 'zbrowse/browser/zguard'];
export function parseStrictMode(args) {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === '--require-live-settings') return true;
  throw new Error('Unsupported live-settings acceptance arguments: use only --require-live-settings');
}
const strict = parseStrictMode(process.argv.slice(2));
const failures = [];

async function boot(packageName, initial) {
  const content = fs.readFileSync(path.join(root, packageName, 'content.js'), 'utf8');
  const stored = { enabled: initial.enabled, mode: initial.mode };
  const changeListeners = [];
  const nativeCalls = [];
  const telemetry = [];
  const documentHandlers = new Map();
  const api = {
    runtime: { sendMessage(data) { telemetry.push(data); } },
    storage: {
      onChanged: { addListener(listener) { changeListeners.push(listener); } },
      local: {
        get(defaults, callback) {
          const current = { ...defaults, ...stored };
          if (typeof callback === 'function') callback(current);
          return Promise.resolve(current);
        },
        set(update, callback) {
          const changes = {};
          for (const [key, value] of Object.entries(update)) {
            changes[key] = { oldValue: stored[key], newValue: value };
            stored[key] = value;
          }
          for (const listener of changeListeners) listener(changes, 'local');
          if (typeof callback === 'function') callback();
          return Promise.resolve();
        }
      }
    }
  };
  const context = {
    URL,
    console,
    location: { href: 'https://origin.test/watch', origin: 'https://origin.test' },
    window: {
      open(url) {
        nativeCalls.push(url);
        return { native: true };
      }
    },
    document: {
      addEventListener(type, handler) { documentHandlers.set(type, handler); },
      removeEventListener(type) { documentHandlers.delete(type); }
    }
  };
  context[packageName === 'firefox' ? 'browser' : 'chrome'] = api;
  vm.runInNewContext(content, context, {
    filename: packageName + '/content.js', timeout: 1000
  });
  await Promise.resolve();
  await Promise.resolve();

  return {
    open(url) { return context.window.open(url); },
    async change(update) {
      await api.storage.local.set(update);
      await Promise.resolve();
      await Promise.resolve();
    },
    listenerCount() { return changeListeners.length; },
    click(href, type = 'click') {
      const node = { closest: () => ({ href, target: '_blank' }) };
      const actions = [];
      const event = {
        type, target: node, composedPath: () => [node],
        ctrlKey: false, metaKey: false, button: type === 'auxclick' ? 1 : 0,
        preventDefault() { actions.push('preventDefault'); },
        stopImmediatePropagation() { actions.push('stopImmediatePropagation'); }
      };
      documentHandlers.get(type)?.(event);
      return actions;
    },
    submit(url) {
      const actions = [];
      documentHandlers.get('submit')?.({
        target: { tagName: 'FORM', action: url, target: '_blank' },
        submitter: null,
        preventDefault() { actions.push('preventDefault'); },
        stopImmediatePropagation() { actions.push('stopImmediatePropagation'); }
      });
      return actions;
    },
    notify(changes, area) {
      for (const listener of changeListeners) listener(changes, area);
    },
    telemetry,
    nativeCalls
  };
}

for (const pkg of packages) {
  const active = await boot(pkg, { enabled: true, mode: 'balanced' });
  assert.notEqual(active.open('https://example.org/watch'), null,
    pkg + ': initial balanced mode should allow ordinary external navigation');
  assert.equal(active.open('https://ads.al5sm.com/popup'), null,
    pkg + ': initial balanced mode should reject known hostile hosts');
  assert.equal(active.listenerCount(), 1,
    pkg + ': attach one settings subscription before hydration');
  await active.change({ mode: 'strict' });
  if (active.open('https://example.org/watch') !== null) {
    failures.push(pkg + ': balanced to strict failed without reload');
  }
  if (!active.click('https://example.org/watch').includes('preventDefault') ||
      !active.click('https://example.org/watch', 'auxclick').includes('preventDefault') ||
      !active.submit('https://example.org/watch').includes('preventDefault')) {
    failures.push(pkg + ': strict live setting did not update link, middle-click and form');
  }
  // Untrusted/invalid storage-change payloads must not disable protection.
  active.notify({ enabled: { newValue: 'false' }, mode: { newValue: 'disabled' } }, 'local');
  active.notify({ enabled: { newValue: false }, mode: { newValue: 'balanced' } }, 'sync');
  if (active.open('https://example.org/watch') !== null) {
    failures.push(pkg + ': invalid or non-local changes modified live protection');
  }
  await active.change({ enabled: false });
  if (active.open('https://ads.al5sm.com/popup') === null) {
    failures.push(pkg + ': enabled to disabled failed without reload');
  }
  if (active.click('https://ads.al5sm.com/popup').length ||
      active.click('https://ads.al5sm.com/popup', 'auxclick').length ||
      active.submit('https://ads.al5sm.com/popup').length) {
    failures.push(pkg + ': disabled live setting left event interceptors active');
  }

  const initiallyDisabled = await boot(pkg, { enabled: false, mode: 'balanced' });
  assert.notEqual(initiallyDisabled.open('https://ads.al5sm.com/popup'), null,
    pkg + ': initially disabled extension must preserve native window.open');
  await initiallyDisabled.change({ enabled: true });
  if (initiallyDisabled.open('https://ads.al5sm.com/popup') !== null) {
    failures.push(pkg + ': disabled to enabled failed without reload');
  }
  if (!initiallyDisabled.submit('https://ads.al5sm.com/popup').length) {
    failures.push(pkg + ': enabling in an already-open tab failed to arm form interception');
  }
  if (initiallyDisabled.listenerCount() !== 1) {
    failures.push(pkg + ': initial disabled state must still subscribe exactly once');
  }

  const initiallyStrict = await boot(pkg, { enabled: true, mode: 'strict' });
  assert.equal(initiallyStrict.open('https://example.org/watch'), null,
    pkg + ': initial strict mode should reject unrelated external navigation');
  await initiallyStrict.change({ mode: 'balanced' });
  if (initiallyStrict.open('https://example.org/watch') === null) {
    failures.push(pkg + ': strict to balanced failed without reload');
  }
}

if (strict) {
  assert.deepEqual(failures, [],
    'Shipped content-script live settings synchronization failures (issue #3): ' +
    failures.join('; '));
  console.log('Content script live mode and enabled-state synchronization passed');
} else {
  console.log('Initial content script balanced/strict/disabled contract passed for ' +
    packages.length + ' packages. Opt-in live-settings proof is ' +
    (failures.length ? 'currently failing ' + failures.length + ' transitions' : 'also green') +
    '. Strict gate: --require-live-settings');
}
