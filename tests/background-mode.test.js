const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

async function loadBackground(relativePath, mode, { enabled = true, openerThrows = false, lastBlocked = null, blockedCount = 0 } = {}) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const settings = { enabled, mode, blockedCount, lastBlocked };
  const removed = [];
  let onCreated;
  let onMessage;
  let onInstalled;

  const api = {
    runtime: {
      onInstalled: { addListener(listener) { onInstalled = listener; } },
      onMessage: { addListener(listener) { onMessage = listener; } }
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
    installed: async () => {
      await Promise.resolve(onInstalled());
      await new Promise((resolve) => setImmediate(resolve));
    },
    message: async (message) => {
      await Promise.resolve(onMessage(message, {}, () => {}));
      await new Promise((resolve) => setImmediate(resolve));
    },
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
  assert.equal(balanced.settings.lastBlocked?.detail?.url, 'https://www.nap5k.com');

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

  // A tab URL's actual authority determines hostile classification.
  // Deceptive userinfo and canonical default ports cannot disguise the host.
  const authority = await loadBackground(relativePath, 'balanced');
  for (const [id, url] of [
    [40, 'https://user:secret@ADS.AL5SM.COM/popup'],
    [41, 'https://ads.al5sm.com@safe.example/popup'],
    [42, 'https://sub.tmll7.com:443/popup'],
    [43, 'https://al5sm.com.attacker.example/'],
    [44, 'https://ads.al5sm.com./popup'],
    [45, 'https://WWW.NAP5K.COM./popup'],
    [46, 'https://nested.Sub.TMLL7.COM./popup'],
    [47, 'https://al5sm.com.attacker.example./popup']
  ]) {
    await authority.created({ id, openerTabId: 1, url });
  }
  assert.deepEqual(authority.removed, [40, 42, 44, 45, 46],
    relativePath + ': balanced fallback must distinguish real hostile hosts from URL lookalikes');
  assert.equal(authority.settings.blockedCount, 5,
    relativePath + ': only genuinely hostile tabs increment the blocked counter');

  // Blocked-event telemetry must never persist credentials, URL paths,
  // query tokens, fragments, arbitrary message detail keys or raw junk URLs.
  const privateTab = await loadBackground(relativePath, 'balanced');
  const secretTarget = 'https://user:secret@ads.al5sm.com/private?api_token=sensitive#fragment';
  await privateTab.created({ id: 60, openerTabId: 1, url: secretTarget });
  assert.deepEqual(privateTab.removed, [60], relativePath + ': secret URL is blocked');
  assert.equal(privateTab.settings.lastBlocked.detail.url, 'https://ads.al5sm.com',
    relativePath + ': new-tab telemetry must persist only the URL origin');
  await privateTab.message({
    type: 'blocked-event', event: 'window-open',
    detail: { url: secretTarget, mode: 'balanced', privateNote: 'never persist me' }
  });
  assert.equal(privateTab.settings.lastBlocked.event, 'window-open');
  assert.equal(privateTab.settings.blockedCount, 2,
    relativePath + ': content-script message must still increment blocked count');
  assert.deepEqual(Object.keys(privateTab.settings.lastBlocked.detail).sort(),
    ['mode', 'url'], relativePath + ': only reviewed telemetry fields may persist');
  assert.equal(privateTab.settings.lastBlocked.detail.url, 'https://ads.al5sm.com');
  assert.equal(privateTab.settings.lastBlocked.detail.mode, 'balanced');
  await privateTab.message({ type: 'blocked-event', event: 'external-link',
    detail: { url: 'data:text/plain,sensitive', mode: 'strict', other: 'private' } });
  assert.equal(privateTab.settings.lastBlocked.detail.url, '[redacted]',
    relativePath + ': opaque/non-web schemes must be redacted');
  await privateTab.message({ type: 'blocked-event', event: 'external-link',
    detail: { url: 'not a parseable URL', mode: 'strict' } });
  assert.equal(privateTab.settings.lastBlocked.detail.url, '[redacted]',
    relativePath + ': malformed URLs must be redacted');

  // Real extension update events must migrate legacy telemetry that
  // previously persisted complete userinfo, path, query and custom fields.
  const historic = await loadBackground(relativePath, 'strict', {
    blockedCount: 7,
    lastBlocked: {
      event: 'new-tab', at: '2026-10-13T12:34:56.000Z',
      detail: { url: 'https://user:password@ads.al5sm.com/private?token=secret#frag',
        unknown: 'do not preserve' },
      privateValue: 'discard this'
    }
  });
  await historic.installed();
  assert.equal(historic.settings.blockedCount, 7,
    relativePath + ': migrating telemetry must preserve block totals');
  assert.deepEqual(Object.keys(historic.settings.lastBlocked).sort(),
    ['at', 'detail', 'event'], relativePath + ': old custom history fields removed');
  assert.equal(historic.settings.lastBlocked.event, 'new-tab');
  assert.equal(historic.settings.lastBlocked.at, '2026-10-13T12:34:56.000Z');
  assert.equal(historic.settings.lastBlocked.detail.url, 'https://ads.al5sm.com');
  assert.deepEqual(Object.keys(historic.settings.lastBlocked.detail), ['url'],
    relativePath + ': legacy details must not retain private keys');
  const broken = await loadBackground(relativePath, 'balanced', {
    lastBlocked: { event: 'untrusted-sensitive-event', at: 'secret',
      detail: { url: 'not a URL', private: 'token' } }
  });
  await broken.installed();
  assert.equal(broken.settings.lastBlocked.event, 'blocked');
  assert.equal(broken.settings.lastBlocked.detail.url, '[redacted]');
  assert.match(broken.settings.lastBlocked.at, /^\d{4}-\d\d-\d\dT/,
    relativePath + ': invalid legacy timestamp must be replaced');

  const originPort = await loadBackground(relativePath, 'strict');
  for (const [id, url] of [
    [50, 'https://origin.test:443/next'],
    [51, 'https://origin.test:8443/next'],
    [52, 'https://sub.origin.test/next']
  ]) {
    await originPort.created({ id, openerTabId: 1, url });
  }
  assert.deepEqual(originPort.removed, [51, 52],
    relativePath + ': strict fallback must preserve same-origin default ports only');

  const disabled = await loadBackground(relativePath, 'strict', { enabled: false });
  await disabled.created({ id: 30, openerTabId: 1, url: 'https://ads.al5sm.com/popup' });
  assert.deepEqual(disabled.removed, [], relativePath + ': disabled mode must not close tabs');
  await disabled.created({ id: 32, openerTabId: 1, url: 'https://ads.al5sm.com./popup' });
  assert.deepEqual(disabled.removed, [], relativePath + ': disabled mode must allow DNS-root-dot hosts');
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
  await verifyBrowser('zbrowse/browser/zguard/background.js');
  console.log('zGuard background mode behavior tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
