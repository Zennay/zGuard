const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

async function loadContentScript(relativePath, mode, overrides = {}) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const events = [];
  let allowedOpenCount = 0;

  const api = {
    runtime: {
      sendMessage(message) {
        events.push(message);
      }
    },
    storage: {
      local: {
        get(defaults, callback) {
          const settings = { ...defaults, enabled: true, mode, ...overrides };
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
      addEventListener() {}
    }
  };

  if (relativePath.startsWith('firefox/')) context.browser = api;
  else context.chrome = api;

  vm.runInNewContext(source, context, { filename: relativePath });
  await new Promise((resolve) => setImmediate(resolve));

  return {
    open: (url) => context.window.open(url),
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

  const malformed = await loadContentScript(relativePath, 'invalid-mode', { enabled: 0 });
  assert.equal(
    malformed.open('https://ads.al5sm.com/popup'),
    null,
    `${relativePath}: malformed persisted settings must fall back to enabled balanced mode`
  );
  assert.equal(malformed.events.at(-1)?.event, 'window-open');
}

(async () => {
  await verifyBrowser('chromium/content.js');
  await verifyBrowser('firefox/content.js');
  console.log('zGuard content mode behavior tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
