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
async function bootPortal({ health, sessionRequest, healthRequest, deleteRequest } = {}) {
  const elements = new Map();
  const requests = [];
  const intervals = new Map();
  const windowEvents = new Map();
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
      if (id === 'browserFrame') {
        // Record every iframe assignment, not only its final value:
        // a stale viewer navigation followed by about:blank is still unsafe.
        const frame = elements.get(id);
        let currentSrc = frame.src;
        frame.srcHistory = [];
        Object.defineProperty(frame, 'src', {
          get() { return currentSrc; },
          set(value) { currentSrc = value; frame.srcHistory.push(value); }
        });
      }
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
    addEventListener(name, callback) { windowEvents.set(name, callback); },
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
      if (healthRequest) return healthRequest();
      return response(health || { status: 'ok', activeSessions: 0, startingSessions: 0, capacity: 1 });
    }
    if (url.startsWith('/api/session/') &&
        /^[A-Za-z0-9_-]{32}$/.test(url.slice('/api/session/'.length)) &&
        options.method === 'DELETE') {
      return deleteRequest ? deleteRequest() : response(null, 204);
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
    pagehide() {
      const callback = windowEvents.get('pagehide');
      assert.equal(typeof callback, 'function', 'portal must register pagehide cleanup');
      callback();
    },
    pageshow(persisted = true) {
      const callback = windowEvents.get('pageshow');
      assert.equal(typeof callback, 'function', 'portal must register BFCache recovery');
      callback({ persisted });
    },
    submit() {
      const listener = element('browserForm').listeners.submit;
      assert.equal(typeof listener, 'function', 'real portal must install form submit listener');
      listener({ preventDefault() {} });
    }
  };
}

(async () => {
  const available = await bootPortal({
    health: { status: 'ok', activeSessions: 0, startingSessions: 0, capacity: 1 }
  });
  assert.equal(available.element('capacityText').textContent, 'Ready to browse');
  assert.equal(available.element('capacityText').parentElement.className, 'status available');
  assert.equal(available.element('startButton').disabled, false,
    'healthy gateway should allow a browser start');

  const starting = await bootPortal({
    health: { status: 'ok', activeSessions: 0, startingSessions: 1, capacity: 1 }
  });
  assert.equal(
    starting.element('capacityText').textContent,
    'Browser currently in use',
    'starting gateway reservations must count against capacity'
  );
  assert.equal(starting.element('capacityText').parentElement.className, 'status busy');
  assert.equal(starting.element('startButton').disabled, false,
    'busy gateway must still allow reusing an existing owner session');

  const active = await bootPortal({
    health: { status: 'ok', activeSessions: 1, startingSessions: 0, capacity: 1 }
  });
  assert.equal(active.element('capacityText').textContent, 'Browser currently in use');

  // A shutdown or drain response is distinct from a busy but healthy gateway.
  // Other unknown statuses and malformed capacity must never claim readiness.
  const draining = await bootPortal({
    health: { status: 'draining', activeSessions: 0, startingSessions: 0, capacity: 1 }
  });
  assert.equal(draining.element('capacityText').textContent,
    'Browser temporarily unavailable');
  assert.equal(draining.element('capacityText').parentElement.className, 'status');
  assert.equal(draining.element('startButton').disabled, true,
    'draining gateway must disable browser creation until healthy');
  draining.submit();
  assert.equal(draining.requests.filter(({ url }) => url === '/api/session').length, 0,
    'scripted form submit cannot bypass draining admission guard');

  const unsafeHealth = [
    ['unknown status', { status: 'degraded', activeSessions: 0, startingSessions: 0, capacity: 1 }],
    ['missing status', { activeSessions: 0, startingSessions: 0, capacity: 1 }],
    ['coerced active count', { status: 'ok', activeSessions: '0', startingSessions: 0, capacity: 1 }],
    ['fractional count', { status: 'ok', activeSessions: 0.5, startingSessions: 0, capacity: 1 }],
    ['negative starting count', { status: 'ok', activeSessions: 0, startingSessions: -1, capacity: 1 }],
    ['invalid capacity', { status: 'ok', activeSessions: 0, startingSessions: 0, capacity: 0 }],
    ['overcapacity', { status: 'ok', activeSessions: 2, startingSessions: 0, capacity: 1 }],
    ['unsafe integer', { status: 'ok', activeSessions: Number.MAX_SAFE_INTEGER + 1,
      startingSessions: 0, capacity: 1 }]
  ];
  for (const [label, health] of unsafeHealth) {
    const portal = await bootPortal({ health });
    assert.equal(portal.element('capacityText').textContent, 'Browser engine offline',
      label + ': invalid health must fail closed without a ready badge');
    assert.equal(portal.element('capacityText').parentElement.className, 'status',
      label + ': invalid health must remove old available/busy styling');
    assert.equal(portal.element('startButton').disabled, true,
      label + ': invalid health must disable admission');
    portal.submit();
    assert.equal(portal.requests.filter(({ url }) => url === '/api/session').length, 0,
      label + ': scripted submit must never start browser on malformed health');
  }

  const validToken = 'A'.repeat(32);
  const validViewer = '/s/' + validToken + '/';
  const validSession = {
    token: validToken,
    viewerUrl: validViewer,
    expiresAt: Date.now() + 60_000,
    maxMinutes: 15
  };

  // Reproduce network reordering: a slow stale healthy result must never
  // override a newer busy observation, even when both requests succeeded.
  const slowReady = deferred();
  const fastBusy = deferred();
  let healthCount = 0;
  const racing = await bootPortal({
    healthRequest() {
      healthCount += 1;
      if (healthCount === 1) return response({ status: 'ok', activeSessions: 0, startingSessions: 0, capacity: 1 });
      return healthCount === 2 ? slowReady.promise : fastBusy.promise;
    }
  });
  const healthPoll = [...racing.intervals.values()].find(({ milliseconds }) => milliseconds === 20000);
  assert.ok(healthPoll, 'live portal must retain its periodic capacity refresh');
  healthPoll.callback();
  healthPoll.callback();
  fastBusy.resolve(response({ status: 'ok', activeSessions: 0, startingSessions: 1, capacity: 1 }));
  await settle();
  assert.equal(racing.element('capacityText').textContent, 'Browser currently in use');
  slowReady.resolve(response({ status: 'ok', activeSessions: 0, startingSessions: 0, capacity: 1 }));
  await settle();
  assert.equal(racing.element('capacityText').textContent, 'Browser currently in use',
    'late stale health success must not overwrite a newer busy state');

  const slowOffline = deferred();
  const fastReady = deferred();
  let checks = 0;
  const recovery = await bootPortal({
    healthRequest() {
      checks += 1;
      if (checks === 1) return response({ status: 'ok', activeSessions: 1, startingSessions: 0, capacity: 1 });
      return checks === 2 ? slowOffline.promise : fastReady.promise;
    }
  });
  const recoveryPoll = [...recovery.intervals.values()].find(({ milliseconds }) => milliseconds === 20000);
  recoveryPoll.callback();
  recoveryPoll.callback();
  fastReady.resolve(response({ status: 'ok', activeSessions: 0, startingSessions: 0, capacity: 1 }));
  await settle();
  slowOffline.reject(new Error('old connection timed out'));
  await settle();
  assert.equal(recovery.element('capacityText').textContent, 'Ready to browse',
    'late stale health error must not mask newer healthy state');
  assert.equal(recovery.element('startButton').disabled, false,
    'stale offline poll must not re-disable browser launch after recovery');

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

  pending.resolve(response(validSession));
  await settle();
  assert.equal(portal.element('browserFrame').src, validViewer);
  assert.equal(portal.element('browserView').hidden, false);
  assert.equal(portal.element('startButton').disabled, false);
  assert.deepEqual(
    [...portal.intervals.values()].map(({ milliseconds }) => milliseconds).sort((a, b) => a - b),
    [1000, 20000, 30000],
    'one session must add only one heartbeat and countdown to the baseline health poller'
  );
  portal.submit();
  assert.equal(
    portal.requests.filter(({ url }) => url === '/api/session').length,
    1,
    'an active session must not allocate another session'
  );

  portal.pagehide();
  await settle();
  const pageExitRequests = portal.requests.filter(({ url }) => url === '/api/session/' + validToken);
  assert.equal(pageExitRequests.length, 1, 'page exit must attempt exactly one session teardown');
  assert.equal(pageExitRequests[0].options.method, 'DELETE', 'page exit must not send a heartbeat');
  assert.equal(pageExitRequests[0].options.keepalive, true, 'page exit teardown must survive document unload');
  assert.equal(
    portal.requests.filter(({ url }) => url.endsWith('/heartbeat')).length,
    0,
    'page exit must not extend the abandoned session lease'
  );

  // Abandon while the gateway is *still* creating a browser. No token
  // exists at pagehide time, but if its response resolves later the original
  // script must release that issued token without ever mounting the viewer.
  const pendingAbandon = deferred();
  const abandoned = await bootPortal({
    sessionRequest: () => pendingAbandon.promise
  });
  abandoned.element('browserView').hidden = true;
  abandoned.submit();
  abandoned.pagehide();
  assert.equal(
    abandoned.requests.filter(({ url, options }) =>
      url === '/api/session/' + validToken && options.method === 'DELETE').length,
    0, 'pagehide cannot delete a token that the gateway has not issued yet'
  );
  pendingAbandon.resolve(response(validSession));
  await settle();
  assert.equal(abandoned.element('browserFrame').srcHistory.includes(validViewer), false,
    'late session completion must never navigate a viewer on an abandoned page');
  assert.equal(abandoned.element('browserView').hidden, true,
    'late session must not render a browser after pagehide');
  assert.deepEqual(
    [...abandoned.intervals.values()].map(({ milliseconds }) => milliseconds),
    [20000], 'abandoned creation must not start heartbeat/countdown timers'
  );
  const lateRelease = abandoned.requests.filter(({ url, options }) =>
    url === '/api/session/' + validToken && options.method === 'DELETE');
  assert.equal(lateRelease.length, 1,
    'late created session must be released exactly once');
  assert.equal(lateRelease[0].options.keepalive, true,
    'late release must be eligible for dispatch during document teardown');
  abandoned.pagehide();
  await settle();
  assert.equal(
    abandoned.requests.filter(({ url, options }) =>
      url === '/api/session/' + validToken && options.method === 'DELETE').length,
    1, 'repeated pagehide must not duplicate already-released late sessions'
  );

  // The explicit End control must free the viewer immediately, keep the
  // ordinary capacity poller alive, and never double-release on unload.
  const manual = await bootPortal({ sessionRequest: async () => response(validSession) });
  manual.submit();
  await settle();
  assert.equal(manual.element('browserView').hidden, false, 'manual-close fixture must mount a viewer');
  const close = manual.element('endButton').listeners.click;
  assert.equal(typeof close, 'function', 'End control must be wired to session teardown');
  await close();
  await settle();
  assert.equal(manual.element('browserView').hidden, true, 'End must return to home view');
  assert.equal(manual.element('homeView').hidden, false, 'End must restore the start form');
  assert.equal(manual.element('browserFrame').src, 'about:blank', 'End must clear viewer content');
  assert.deepEqual(
    [...manual.intervals.values()].map(({ milliseconds }) => milliseconds),
    [20000], 'End must clear countdown and heartbeat but preserve health polling'
  );
  assert.equal(
    manual.requests.filter(({ url, options }) =>
      url === '/api/session/' + validToken && options.method === 'DELETE').length,
    1, 'End must release gateway capacity exactly once'
  );
  await close();
  manual.pagehide();
  await settle();
  assert.equal(
    manual.requests.filter(({ url, options }) =>
      url === '/api/session/' + validToken && options.method === 'DELETE').length,
    1, 'repeated End and later pagehide must not double-release the same session'
  );

  // When the user ends a viewer, a slow DELETE must hold start admission.
  // Otherwise the same-IP gateway can reuse the about-to-be-revoked token.
  const heldDelete = deferred();
  let allocations = 0;
  const overlapping = await bootPortal({
    sessionRequest: async () => {
      allocations++;
      return response(validSession);
    },
    deleteRequest: () => heldDelete.promise
  });
  overlapping.submit();
  await settle();
  const endPending = overlapping.element('endButton').listeners.click();
  assert.equal(overlapping.element('browserView').hidden, true,
    'ending a browser should hide it immediately, without waiting for DELETE');
  assert.equal(overlapping.element('startButton').disabled, true,
    'start must stay disabled until the old gateway session has been released');
  overlapping.submit(); // scripted submit bypasses native disabled buttons
  await settle();
  assert.equal(allocations, 1,
    'pending DELETE must prevent same-IP reuse through form submit');
  assert.equal(overlapping.requests.filter(({ url, options }) =>
    url === '/api/session/' + validToken && options.method === 'DELETE').length, 1,
  'ending a session must dispatch only one teardown request');
  assert.equal(overlapping.requests.find(({ url, options }) =>
    url === '/api/session/' + validToken && options.method === 'DELETE')
    .options.keepalive, true, 'pending user-initiated teardown must survive page exit');
  heldDelete.resolve(response(null, 204));
  await endPending;
  await settle();
  assert.equal(overlapping.element('startButton').disabled, false,
    'completed teardown must unlock subsequent browser admission');
  overlapping.submit();
  await settle();
  assert.equal(allocations, 2,
    'fresh POST after completed teardown must still work');

  // A BFCache back-navigation may restore a page after its pagehide
  // keepalive DELETE. A restored viewer must not continue using that token,
  // and a retry DELETE is required if the unload request was lost.
  const restored = await bootPortal({ sessionRequest: async () => response(validSession) });
  restored.submit();
  await settle();
  assert.equal(restored.element('browserView').hidden, false);
  restored.pageshow(false);
  await settle();
  assert.equal(
    restored.requests.filter(({ url, options }) =>
      url === '/api/session/' + validToken && options.method === 'DELETE').length,
    0, 'ordinary initial pageshow must never end a working session'
  );
  restored.pagehide();
  await settle();
  assert.equal(
    restored.requests.filter(({ url, options }) =>
      url === '/api/session/' + validToken && options.method === 'DELETE').length,
    1, 'pagehide must dispatch first capacity release'
  );
  restored.pageshow(true);
  await settle();
  assert.equal(restored.element('browserFrame').src, 'about:blank',
    'BFCache restore must immediately discard stale bearer viewer');
  assert.equal(restored.element('browserView').hidden, true,
    'restored page must return to browser start form');
  assert.equal(restored.element('homeView').hidden, false);
  assert.deepEqual(
    [...restored.intervals.values()].map(({ milliseconds }) => milliseconds),
    [20000], 'BFCache restore must clear the old heartbeat and countdown');
  assert.equal(
    restored.requests.filter(({ url, options }) =>
      url === '/api/session/' + validToken && options.method === 'DELETE').length,
    2, 'BFCache restore should retry teardown if pagehide keepalive was lost'
  );
  restored.pagehide();
  await settle();
  assert.equal(
    restored.requests.filter(({ url, options }) =>
      url === '/api/session/' + validToken && options.method === 'DELETE').length,
    2, 'subsequent pagehide must not release a discarded BFCache session again'
  );

  // A lost heartbeat must invalidate the portal session. The viewer cannot
  // continue displaying an orphaned session when the gateway rejects renewal.
  const heartbeatLost = await bootPortal({ sessionRequest: async () => response(validSession) });
  heartbeatLost.submit();
  await settle();
  const heartbeat = [...heartbeatLost.intervals.values()].find(({ milliseconds }) =>
    milliseconds === 30000
  );
  assert.ok(heartbeat, 'session must register a heartbeat timer');
  heartbeat.callback();
  await settle();
  assert.equal(heartbeatLost.element('browserFrame').src, 'about:blank',
    'heartbeat failure must clear the viewer');
  assert.equal(heartbeatLost.element('browserView').hidden, true,
    'heartbeat failure must return to home');
  assert.deepEqual(
    [...heartbeatLost.intervals.values()].map(({ milliseconds }) => milliseconds),
    [20000], 'heartbeat failure must tear down session-owned timers'
  );
  assert.equal(
    heartbeatLost.requests.filter(({ url, options }) =>
      url === '/api/session/' + validToken && options.method === 'DELETE').length,
    1, 'heartbeat failure must attempt one capacity release'
  );

  // The server-provided absolute expiry is enforced immediately, without
  // waiting for the first countdown tick or starting a lingering heartbeat.
  const expired = await bootPortal({
    sessionRequest: async () => response({ ...validSession, expiresAt: Date.now() - 1000 })
  });
  expired.submit();
  await settle();
  assert.equal(expired.element('browserFrame').src, 'about:blank',
    'already-expired session must not leave a viewer mounted');
  assert.equal(expired.element('browserFrame').srcHistory.includes(validViewer), false,
    'already-expired bearer URL must never be assigned to the iframe even briefly');
  assert.equal(expired.element('browserView').hidden, true);
  assert.deepEqual(
    [...expired.intervals.values()].map(({ milliseconds }) => milliseconds),
    [20000], 'expired session must not leave a heartbeat/countdown running'
  );
  assert.equal(
    expired.requests.filter(({ url, options }) =>
      url === '/api/session/' + validToken && options.method === 'DELETE').length,
    1, 'already-expired session must immediately release capacity'
  );

  const noSession = await bootPortal();
  noSession.pagehide();
  await settle();
  assert.equal(noSession.requests.filter(({ url }) => url.startsWith('/api/session')).length, 0,
    'leaving without an active session must never send a teardown');

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

  const invalidSessions = [
    ['absolute viewer', { ...validSession, viewerUrl: 'https://untrusted.example/viewer' }],
    ['javascript viewer', { ...validSession, viewerUrl: 'javascript:alert(1)' }],
    ['path traversal viewer', { ...validSession, viewerUrl: '/s/' + validToken + '/../other/' }],
    ['other session viewer', { ...validSession, viewerUrl: '/s/' + 'B'.repeat(32) + '/' }],
    ['traversal token', { ...validSession, token: '../other' }],
    ['short token', { ...validSession, token: 'short' }],
    ['missing token', { ...validSession, token: undefined }],
    ['string expiry', { ...validSession, expiresAt: String(validSession.expiresAt) }],
    ['nonsafe expiry', { ...validSession, expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['invalid duration', { ...validSession, maxMinutes: 0 }],
    ['missing duration', { ...validSession, maxMinutes: undefined }],
    ['null payload', null]
  ];

  for (const [label, payload] of invalidSessions) {
    const candidate = await bootPortal({ sessionRequest: async () => response(payload) });
    candidate.element('browserView').hidden = true;
    candidate.submit();
    await settle();
    assert.equal(candidate.element('browserFrame').src, '', label + ': no iframe navigation');
    assert.equal(candidate.element('browserView').hidden, true, label + ': no session mounted');
    assert.equal(candidate.element('formMessage').textContent,
      'Invalid browser session response.', label + ': generic error shown');
    assert.deepEqual(
      [...candidate.intervals.values()].map(({ milliseconds }) => milliseconds),
      [20000], label + ': rejected payload must not start heartbeats or countdowns'
    );
    assert.equal(candidate.element('startButton').disabled, false, label + ': retry remains available');
  }

  console.log('zBrowse portal capacity, ordered health polls, admission, payload and page-exit teardown validated');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
