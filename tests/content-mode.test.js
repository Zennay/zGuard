const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

async function loadContentScript(relativePath, mode, enabled = true) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const events = [];
  let allowedOpenCount = 0;
  let clickHandler;

  const api = {
    runtime: {
      sendMessage(message) {
        events.push(message);
      }
    },
    storage: {
      local: {
        get(defaults, callback) {
          const settings = { ...defaults, enabled, mode };
          if (typeof callback === 'function') {
            callback(settings);
            return undefined;
          }
          return Promise.resolve(settings);
        }
      }
    }
  };

  const context = {
    URL,
    console,
    location: {
      href: 'https://origin.test/watch',
      origin: 'https://origin.test'
    },
    window: {
      open(url) {
        allowedOpenCount += 1;
        return { allowed: true, url };
      }
    },
    document: {
      addEventListener(name, listener) {
        if (name === 'click') clickHandler = listener;
      }
    }
  };

  if (relativePath.startsWith('firefox/')) context.browser = api;
  else context.chrome = api;

  vm.runInNewContext(source, context, { filename: relativePath });
  await new Promise((resolve) => setImmediate(resolve));

  return {
    open: (url) => context.window.open(url),
    click(href, { target = '_blank', ctrlKey = false, metaKey = false, button = 0 } = {}) {
      const actions = [];
      const event = {
        target: { closest: (selector) => selector === 'a' ? { href, target } : null },
        ctrlKey, metaKey, button,
        preventDefault() { actions.push('preventDefault'); },
        stopImmediatePropagation() { actions.push('stopImmediatePropagation'); }
      };
      if (clickHandler) clickHandler(event);
      return actions;
    },
    events,
    allowedOpenCount: () => allowedOpenCount
  };
}

async function verifyBrowser(relativePath) {
  const balanced = await loadContentScript(relativePath, 'balanced');
  assert.notEqual(
    balanced.open('https://example.org/movie'),
    null,
    `${relativePath}: balanced mode must allow ordinary external opens`
  );
  assert.equal(balanced.allowedOpenCount(), 1);
  assert.equal(balanced.events.length, 0);

  assert.equal(
    balanced.open('https://ads.al5sm.com/popup'),
    null,
    `${relativePath}: balanced mode must still block hostile hosts`
  );
  assert.equal(balanced.events.at(-1)?.event, 'window-open');

  const strict = await loadContentScript(relativePath, 'strict');
  assert.equal(
    strict.open('https://example.org/movie'),
    null,
    `${relativePath}: strict mode must block external opens`
  );
  assert.equal(strict.allowedOpenCount(), 0);

  assert.notEqual(
    strict.open('https://origin.test/next'),
    null,
    `${relativePath}: strict mode must allow same-origin opens`
  );
  assert.equal(strict.allowedOpenCount(), 1);

  // Exercise link clicks, not only window.open: modified new-tab clicks must be guarded.
  assert.deepEqual(balanced.click('https://example.org/movie'), []);
  assert.deepEqual(
    balanced.click('https://sub.tmll7.com/popup', { target: '_self', ctrlKey: true }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': hostile Ctrl-click must be intercepted'
  );
  assert.equal(balanced.events.at(-1)?.event, 'external-link');
  assert.deepEqual(
    balanced.click('https://al5sm.com.attacker.example/'),
    [],
    relativePath + ': a lookalike domain must not be mistaken for a hostile subdomain'
  );
  assert.deepEqual(
    balanced.click('https://ads.al5sm.com/popup', { target: '_self' }),
    [],
    relativePath + ': ordinary same-tab navigation is not a popup gesture'
  );

  for (const gesture of [
    { target: '_blank' },
    { target: '_self', ctrlKey: true },
    { target: '_self', metaKey: true },
    { target: '_self', button: 1 }
  ]) {
    assert.deepEqual(
      strict.click('https://example.org/next', gesture),
      ['preventDefault', 'stopImmediatePropagation'],
      relativePath + ': strict mode must intercept each new-tab click gesture'
    );
  }
  assert.deepEqual(
    strict.click('https://origin.test/next', { target: '_blank' }),
    [],
    relativePath + ': strict mode must allow same-origin new-tab clicks'
  );
  assert.deepEqual(
    strict.click('https://example.org/next', { target: '_self' }),
    [],
    relativePath + ': strict mode must not prevent normal same-tab links'
  );
  assert.equal(
    strict.events.filter((event) => event.event === 'external-link').length,
    4,
    relativePath + ': each blocked click must be recorded once'
  );

  const disabled = await loadContentScript(relativePath, 'strict', false);
  assert.notEqual(
    disabled.open('https://ads.al5sm.com/popup'),
    null,
    relativePath + ': disabled mode must preserve native window.open'
  );
  assert.deepEqual(disabled.click('https://ads.al5sm.com/popup'), []);
  assert.equal(disabled.events.length, 0);
}

(async () => {
  await verifyBrowser('chromium/content.js');
  await verifyBrowser('firefox/content.js');
  console.log('zGuard content mode behavior tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
