const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(
  path.resolve(__dirname, '../zbrowse/gateway/public/app.js'),
  'utf8'
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function response(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  await tick();
  await tick();
  await tick();
}

// Execute the real browser script with deterministic DOM, HTTP and timer fakes.
// No network requests, browser installation or gateway containers are required.
async function bootPortal({ health, sessionRequest } = {}) {
  const elements = new Map();
  const requests = [];
  const intervals = new Map();
  let nextInterval = 1;

  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id, value: '', textContent: '', className: '', hidden: false,
        disabled: false, src: '', parentElement: { className: '' },
        listeners: {},
        addEventListener(event, callback) { this.listeners[event] = callback; },
        replaceChildren(...children) { this.children = children; },
        focus() { this.focused = true; },
        requestFullscreen: async () => {}
      });
    }
    return elements.get(id);
  }

  const document = {
    getElementById: element,
    createElement: () => element('option-' + elements.size),
    addEventListener() {},
    fullscreenElement: null,
    exitFullscreen: async () => {}
  };
  const window = {
    addEventListener() {},
    setInterval(callback, milliseconds) {
      const id = nextInterval++;
      intervals.set(id, { callback, milliseconds });
      return id;
    },
    clearInterval(id) { intervals.delete(id); }
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/sites') {
      return response({ sites: [{ name: 'Approved', url: 'https://approved.test/' }] });
    }
    if (url === '/api/health') {
      return response(health || { activeSessions: 0, startingSessions: 0, capacity: 1 });
    }
    if (url === '/api/session' && options.method === 'POST') {
      if (!sessionRequest) throw new Error('unexpected session start request');
      return sessionRequest();
    }
    throw new Error('unexpected portal request: ' + url);
  };

  vm.runInNewContext(app, { document, window, navigator: {}, fetch, Blob, Date, console }, {
    filename: 'zbrowse/gateway/public/app.js',
    timeout: 1000
  });
  await settle();

  return {
    element,
    requests,
    intervals,
    submit() {
      const listener = element('browserForm').listeners.submit;
      assert.equal(typeof listener, 'function', 'real portal must install form submit listener');
      listener({ preventDefault() {} });
    }
  };
}

(async () => {
  const available = await bootPortal({
    health: { activeSessions: 0, startingSessions: 0, capacity: 1 }
  });
  assert.equal(available.element('capacityText').textContent, 'Ready to browse');
  assert.equal(available.element('capacityText').parentElement.className, 'status available');

  const starting = await bootPortal({
    health: { activeSessions: 0, startingSessions: 1, capacity: 1 }
  });
  assert.equal(
    starting.element('capacityText').textContent,
    'Browser currently in use',
    'starting gateway reservations must count against capacity'
  );
  assert.equal(starting.element('capacityText').parentElement.className, 'status busy');

  const active = await bootPortal({
    health: { activeSessions: 1, startingSessions: 0, capacity: 1 }
  });
  assert.equal(active.element('capacityText').textContent, 'Browser currently in use');

  const pending = deferred();
  const portal = await bootPortal({ sessionRequest: () => pending.promise });
  portal.submit();
  portal.submit();
  assert.equal(
    portal.requests.filter(({ url, options }) => url === '/api/session' && options.method === 'POST').length,
    1,
    'two rapid form submits must allocate only one browser session'
  );
  assert.equal(portal.element('startButton').disabled, true, 'start must remain disabled while pending');

  pending.resolve(response({
    token: 'safe-token',
    viewerUrl: '/session/safe-token/viewer',
    expiresAt: Date.now() + 60_000
  }));
  await settle();
  assert.equal(portal.element('browserFrame').src, '/session/safe-token/viewer');
  assert.equal(portal.element('browserView').hidden, false);
  assert.equal(portal.element('startButton').disabled, false);
  assert.equal(portal.intervals.size, 2, 'one session must create one heartbeat and countdown');
  portal.submit();
  assert.equal(
    portal.requests.filter(({ url }) => url === '/api/session').length,
    1,
    'an active session must not allocate another session'
  );

  const failed = deferred();
  const retry = await bootPortal({ sessionRequest: () => failed.promise });
  retry.submit();
  failed.reject(new Error('gateway offline'));
  await settle();
  assert.equal(retry.element('startButton').disabled, false, 'failed start must reset admission');
  assert.equal(retry.element('formMessage').textContent, 'gateway offline');
  retry.submit();
  assert.equal(
    retry.requests.filter(({ url }) => url === '/api/session').length,
    2,
    'failed session start must permit a subsequent retry'
  );

  console.log('zBrowse portal capacity, concurrent start, retry and session lifecycle regressions passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
