const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

async function loadBackground(relativePath, mode, { enabled = true, openerThrows = false, lastBlocked = null, blockedCount = 0, delayMs = 0 } = {}) {
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
          const read = () => {
            const value = { ...defaults, ...settings };
            if (typeof callback === 'function') callback(value);
            return value;
          };
          if (delayMs) return new Promise((resolve) => setTimeout(() => resolve(read()), delayMs));
          const value = read();
          return typeof callback === 'function' ? undefined : Promise.resolve(value);
        },
        set(patch, callback) {
          const write = () => {
            Object.assign(settings, patch);
            if (typeof callback === 'function') callback();
          };
          if (delayMs) return new Promise((resolve) => setTimeout(() => {
            write();
            resolve();
          }, delayMs));
          write();
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
    message: (message) => new Promise((resolve, reject) => {
      const result = onMessage(message, {}, resolve);
      if (result && typeof result.then === 'function') {
        result.then(resolve, reject);
      } else if (result !== true && message.type === 'blocked-event') {
        // Chromium's event listener returns false before its async queue
        // finishes. A get-settings response is a read barrier.
        const barrier = onMessage({ type: 'get-settings' }, {}, resolve);
        if (barrier && typeof barrier.then === 'function') barrier.then(resolve, reject);
      } else if (result !== true) {
        resolve(undefined);
      }
    }),
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

  // A browser-created popup may expose its destination only as pendingUrl.
  // Evaluate the committed URL first, falling back only when it is empty.
  const pending = await loadBackground(relativePath, 'balanced');
  await pending.created({ id: 101, openerTabId: 1, url: '', pendingUrl: 'https://ads.al5sm.com/hidden?secret=1' });
  await pending.created({ id: 102, openerTabId: 1, pendingUrl: 'https://WWW.NAP5K.COM./popup' });
  await pending.created({ id: 103, openerTabId: 1, url: 'https://example.org/safe', pendingUrl: 'https://ads.al5sm.com/bait' });
  await pending.created({ id: 104, openerTabId: 1, url: '', pendingUrl: 'about:blank' });
  await pending.created({ id: 105, openerTabId: 1, url: '', pendingUrl: 'file:///etc/passwd' });
  await pending.created({ id: 106, openerTabId: 1, url: '', pendingUrl: 'not a URL' });
  await pending.created({ id: 107, openerTabId: 1, url: '', pendingUrl: '' });
  assert.deepEqual(pending.removed, [101, 102],
    relativePath + ': pending hostile URLs must close; safe/opaque/incomplete tabs must remain open');
  assert.equal(pending.settings.blockedCount, 2);
  assert.equal(pending.settings.lastBlocked.detail.url, 'https://www.nap5k.com.',
    relativePath + ': telemetry must retain origin of evaluated pending destination');
  const strictPending = await loadBackground(relativePath, 'strict');
  await strictPending.created({ id: 108, openerTabId: 1, url: '', pendingUrl: 'https://external.example/new' });
  await strictPending.created({ id: 109, openerTabId: 1, url: '', pendingUrl: 'https://origin.test/allowed' });
  await strictPending.created({ id: 110, openerTabId: 1, url: 'about:blank', pendingUrl: 'https://external.example/later' });
  assert.deepEqual(strictPending.removed, [108],
    relativePath + ': strict pending external tabs close, same-origin/internal tabs remain open');
  assert.equal(strictPending.settings.lastBlocked.detail.url, 'https://external.example');

  // Deliberately delayed storage operations recreate the lost-update race.
  // Independent overlapping user changes must both survive completion.
  const concurrent = await loadBackground(relativePath, 'balanced', { delayMs: 4 });
  const [disableResponse, strictResponse] = await Promise.all([
    concurrent.message({ type: 'set-settings', settings: { enabled: false, blockedCount: 900, lastBlocked: { detail: { url: 'https://secret.test/?token=1' } } } }),
    concurrent.message({ type: 'set-settings', settings: { mode: 'strict', injected: true } })
  ]);
  assert.equal(concurrent.settings.enabled, false, relativePath + ': disable setting survived overlap');
  assert.equal(concurrent.settings.mode, 'strict', relativePath + ': strict setting survived overlap');
  assert.equal(concurrent.settings.blockedCount, 0, relativePath + ': user settings may not alter telemetry counter');
  assert.equal(concurrent.settings.lastBlocked, null, relativePath + ': user settings may not inject blocked history');
  const settingsReply = await concurrent.message({ type: 'get-settings' });
  assert.equal(settingsReply.enabled, false);
  assert.equal(settingsReply.mode, 'strict');
  assert.equal(strictResponse.mode, 'strict');
  assert.equal(disableResponse.enabled, false);
  // Two separate event producers previously read the same count, losing
  // increments when delayed writes eventually overwrote each other.
  const events = await loadBackground(relativePath, 'balanced', { delayMs: 4 });
  const incoming = Array.from({ length: 6 }, (_, index) => events.message({
    type: 'blocked-event', event: 'window-open',
    detail: { url: 'https://user:password@ads.al5sm.com/private?token=' + index }
  }));
  const tabs = Array.from({ length: 4 }, (_, index) => events.created({
    id: 200 + index, openerTabId: 1, pendingUrl: 'https://ads.al5sm.com/popup/' + index
  }));
  await Promise.all([...incoming, ...tabs]);
  const afterEvents = await events.message({ type: 'get-settings' });
  assert.equal(afterEvents.blockedCount, 10,
    relativePath + ': six message events and four new tabs must produce ten counted blocks');
  assert.equal(events.settings.blockedCount, 10);
  assert.equal(events.removed.length, 4);
  assert.equal(afterEvents.lastBlocked.detail.url, 'https://ads.al5sm.com',
    relativePath + ': serialized telemetry must preserve only sanitized URL origins');

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
