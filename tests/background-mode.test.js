const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

async function loadBackground(relativePath, mode, { enabled = true, openerThrows = false } = {}) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const settings = { enabled, mode, blockedCount: 0, lastBlocked: null };
  const removed = [];
  let onCreated;

  const api = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener() {} }
    },
    storage: {
      local: {
        get(defaults, callback) {
          const value = { ...defaults, ...settings };
          if (typeof callback === 'function') {
            callback(value);
            return undefined;
          }
          return Promise.resolve(value);
        },
        set(patch, callback) {
          Object.assign(settings, patch);
          if (typeof callback === 'function') callback();
          return Promise.resolve();
        }
      }
    },
    tabs: {
      onCreated: {
        addListener(listener) {
          onCreated = listener;
        }
      },
      get: async () => {
        if (openerThrows) throw new Error('opener closed');
        return { url: 'https://origin.test/watch' };
      },
      remove: async (tabId) => {
        removed.push(tabId);
      }
    }
  };

  const context = { URL, console };
  if (relativePath.startsWith('firefox/')) context.browser = api;
  else context.chrome = api;

  vm.runInNewContext(source, context, { filename: relativePath });
  assert.equal(typeof onCreated, 'function', `${relativePath}: tab listener was not registered`);

  return {
    created: (tab) => onCreated(tab),
    removed,
    settings
  };
}

async function verifyBrowser(relativePath) {
  const balanced = await loadBackground(relativePath, 'balanced');
  await balanced.created({ id: 10, openerTabId: 1, url: 'https://example.org/movie' });
  assert.deepEqual(
    balanced.removed,
    [],
    `${relativePath}: balanced fallback must allow ordinary external tabs`
  );

  await balanced.created({ id: 11, openerTabId: 1, url: 'https://ads.al5sm.com/popup' });
  assert.deepEqual(
    balanced.removed,
    [11],
    `${relativePath}: balanced fallback must close hostile tabs`
  );
  assert.equal(balanced.settings.lastBlocked?.event, 'new-tab');

  const strict = await loadBackground(relativePath, 'strict');
  await strict.created({ id: 20, openerTabId: 1, url: 'https://example.org/movie' });
  assert.deepEqual(
    strict.removed,
    [20],
    `${relativePath}: strict fallback must close ordinary external tabs`
  );

  await strict.created({ id: 21, openerTabId: 1, url: 'https://origin.test/next' });
  assert.deepEqual(
    strict.removed,
    [20],
    `${relativePath}: strict fallback must preserve same-origin tabs`
  );

  await balanced.created({ id: 12, openerTabId: 1, url: 'https://www.nap5k.com/popup' });
  assert.deepEqual(
    balanced.removed,
    [11, 12],
    relativePath + ': hostile www-prefixed domains must also be closed'
  );
  assert.equal(balanced.settings.blockedCount, 2);
  assert.equal(balanced.settings.lastBlocked?.detail?.url, 'https://www.nap5k.com/popup');

  await balanced.created({ id: 13, openerTabId: 1, url: 'https://nap5k.com.attacker.example/' });
  assert.deepEqual(
    balanced.removed,
    [11, 12],
    relativePath + ': unrelated suffix lookalikes must not be blocked'
  );

  await strict.created({ id: 22, url: 'https://ads.al5sm.com/popup' });
  await strict.created({ id: 23, openerTabId: 1 });
  assert.deepEqual(
    strict.removed,
    [20],
    relativePath + ': direct navigation and tabs without URLs must not be closed as popups'
  );

  const disabled = await loadBackground(relativePath, 'strict', { enabled: false });
  await disabled.created({ id: 30, openerTabId: 1, url: 'https://ads.al5sm.com/popup' });
  assert.deepEqual(disabled.removed, [], relativePath + ': disabled mode must not close tabs');
  assert.equal(disabled.settings.blockedCount, 0);

  const missingOpener = await loadBackground(relativePath, 'strict', { openerThrows: true });
  await missingOpener.created({ id: 31, openerTabId: 999, url: 'https://ads.al5sm.com/popup' });
  assert.deepEqual(
    missingOpener.removed,
    [],
    relativePath + ': a closed opener must not cause indiscriminate tab removal'
  );
  assert.equal(missingOpener.settings.blockedCount, 0);

}

(async () => {
  await verifyBrowser('chromium/background.js');
  await verifyBrowser('firefox/background.js');
  console.log('zGuard background mode behavior tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
