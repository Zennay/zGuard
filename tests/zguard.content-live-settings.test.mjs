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
const strict = process.argv.includes('--require-live-settings');
const failures = [];

async function boot(packageName, initial) {
  const content = fs.readFileSync(path.join(root, packageName, 'content.js'), 'utf8');
  const stored = { enabled: initial.enabled, mode: initial.mode };
  const changeListeners = [];
  const nativeCalls = [];
  const telemetry = [];
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
      addEventListener() {},
      removeEventListener() {}
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
  await active.change({ mode: 'strict' });
  if (active.open('https://example.org/watch') !== null) {
    failures.push(pkg + ': balanced to strict failed without reload');
  }
  await active.change({ enabled: false });
  if (active.open('https://ads.al5sm.com/popup') === null) {
    failures.push(pkg + ': enabled to disabled failed without reload');
  }

  const initiallyDisabled = await boot(pkg, { enabled: false, mode: 'balanced' });
  assert.notEqual(initiallyDisabled.open('https://ads.al5sm.com/popup'), null,
    pkg + ': initially disabled extension must preserve native window.open');
  await initiallyDisabled.change({ enabled: true });
  if (initiallyDisabled.open('https://ads.al5sm.com/popup') !== null) {
    failures.push(pkg + ': disabled to enabled failed without reload');
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
