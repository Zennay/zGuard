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
async function bootPortal({ health, sessionRequest, healthRequest, deleteRequest, siteRequest } = {}) {
  const elements = new Map();
  const requests = [];
  const intervals = new Map();
  const windowEvents = new Map();
  const fullscreenEvents = [];
  const documentEvents = new Map();
  const timeoutControls = [];
  const AbortSignal = {
    timeout(ms) {
      assert.equal(ms, 7000, 'readiness GET must use bounded timeout');
      const controller = new AbortController();
      timeoutControls.push(controller);
      return controller.signal;
    }
  };
  let nextInterval = 1;

  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id, value: '', textContent: '', className: '', hidden: false,
        disabled: false, src: '', parentElement: { className: '' },
        listeners: {},
        addEventListener(event, callback) { this.listeners[event] = callback; },
        setAttribute(name, value) { (this.attributes ||= {})[name] = String(value); },
        getAttribute(name) { return this.attributes?.[name] ?? null; },
        replaceChildren(...children) { this.children = children; },
        focus() { this.focused = true; },
        async requestFullscreen() {
          fullscreenEvents.push('enter:' + id);
          document.fullscreenElement = this;
          documentEvents.get('fullscreenchange')?.();
        }
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
    addEventListener(event, callback) { documentEvents.set(event, callback); },
    fullscreenElement: null,
    async exitFullscreen() {
      fullscreenEvents.push('exit');
      this.fullscreenElement = null;
      documentEvents.get('fullscreenchange')?.();
    }
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
      return siteRequest ? siteRequest(options) :
        response({ sites: [{ name: 'Approved', url: 'https://approved.test/' }] });
    }
    if (url === '/api/health') {
      if (healthRequest) return healthRequest(options);
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

  vm.runInNewContext(app, { document, window, navigator: {}, fetch, Blob, Date, URL, AbortSignal, console }, {
    filename: 'zbrowse/gateway/public/app.js',
    timeout: 1000
  });
  await settle();

  return {
    element,
    requests,
    intervals,
    document,
    fullscreenEvents,
    timeoutControls,
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
  // A cached 200 health response can continue advertising a ready browser
  // after the gateway becomes busy/draining. The client must bypass its
  // own HTTP cache independently of server/CDN Cache-Control policy.
  const initialHealth = available.requests.filter(({ url }) => url === '/api/health');
  assert.equal(initialHealth.length, 1, 'boot must fetch actual gateway health');
  assert.equal(initialHealth[0].options.cache, 'no-store',
    'gateway health GET must bypass the browser HTTP cache');
  const healthInterval = [...available.intervals.values()]
    .find(({ milliseconds }) => milliseconds === 20000);
  assert.ok(healthInterval, 'readiness must periodically refresh');
  healthInterval.callback();
  await settle();
  assert.equal(available.requests.filter(({ url }) => url === '/api/health').length, 2);
  assert.equal(available.requests.filter(({ url }) => url === '/api/health')[1].options.cache,
    'no-store', 'every health poll must bypass the browser HTTP cache');
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

  // Public health may be green while /api/sites is offline or supplies an
  // invalid catalogue (issue #293). Do not enable the Open button, prefill an
  // unreviewed URL or send a browser POST merely because capacity is free.
  const healthy = { status: 'ok', activeSessions: 0, startingSessions: 0, capacity: 1 };
  const catalogueFailures = [
    ['offline catalogue', () => Promise.reject(new TypeError('gateway route unreachable'))],
    ['missing sites', () => response({})],
    ['null sites', () => response({ sites: null })],
    ['empty catalogue', () => response({ sites: [] })],
    ['unreadable name', () => response({ sites: [
      { name: ' ', url: 'https://approved.test/' }
    ] })],
    ['HTTP suggestion', () => response({ sites: [
      { name: 'Untrusted', url: 'http://approved.test/' }
    ] })],
    ['userinfo suggestion', () => response({ sites: [
      { name: 'Credentials', url: 'https://user:pass@approved.test/' }
    ] })],
    ['unsafe scheme', () => response({ sites: [
      { name: 'Executable', url: 'javascript:alert(1)' }
    ] })],
    ['duplicate site', () => response({ sites: [
      { name: 'Primary', url: 'https://approved.test/' },
      { name: 'Duplicate', url: 'https://approved.test/' }
    ] })]
  ];
  for (const [label, siteRequest] of catalogueFailures) {
    const bad = await bootPortal({ health: healthy, siteRequest });
    assert.equal(bad.element('startButton').disabled, true,
      label + ': healthy API status must not enable a missing/unreviewed site catalogue');
    assert.equal(bad.element('capacityText').textContent, 'Site catalogue unavailable',
      label + ': capacity status must not advertise a usable browser');
    assert.equal(bad.element('capacityText').parentElement.className, 'status',
      label + ': stale green readiness must be removed');
    assert.match(bad.element('formMessage').textContent, /Reload to retry/,
      label + ': user needs actionable recovery information');
    assert.equal(bad.element('urlInput').value, '',
      label + ': unsafe first suggestion must not be prefilled');
    assert.equal(bad.element('siteSuggestions').children.length, 0,
      label + ': never display suggestions from a rejected catalogue');
    bad.element('urlInput').value = 'https://approved.test/';
    bad.submit();
    await settle();
    assert.equal(bad.requests.filter(({ url }) => url === '/api/session').length, 0,
      label + ': scripted submit must not allocate a browser');
    const poll = [...bad.intervals.values()].find(({ milliseconds }) => milliseconds === 20000);
    assert.ok(poll, label + ': healthy polling must remain active for recovery UI');
    poll.callback();
    await settle();
    assert.equal(bad.element('startButton').disabled, true,
      label + ': repeated good health must not bypass site catalogue gate');
  }
  const reviewedSite = await bootPortal({
    health: healthy,
    siteRequest: () => response({ sites: [
      { name: 'Curated', url: 'https://approved.test/' }
    ] })
  });
  assert.equal(reviewedSite.element('startButton').disabled, false,
    'valid catalogue and healthy gateway must keep normal start functionality');
  assert.equal(reviewedSite.element('urlInput').value, 'https://approved.test/',
    'reviewed suggestion must still prefill the canonical URL');
  assert.equal(reviewedSite.element('siteSuggestions').children.length, 1,
    'valid reviewed catalogue must still render its suggested site');

  // Once /api/sites returns, the regular health poll must be able to
  // recover a temporarily unavailable TV without a human or remote reload.
  // Initial boot intentionally makes two attempts (startup + health), each
  // failing; the later periodic poll is the first successful catalogue fetch.
  let catalogueAttempts = 0;
  const recoveredCatalogue = await bootPortal({
    siteRequest() {
      catalogueAttempts++;
      return catalogueAttempts <= 2
        ? Promise.reject(new TypeError('temporary catalogue outage'))
        : response({ sites: [{ name: 'Recovered', url: 'https://approved.test/' }] });
    }
  });
  assert.equal(catalogueAttempts, 2,
    'bootstrap must attempt the catalogue before showing healthy capacity');
  assert.equal(recoveredCatalogue.element('startButton').disabled, true,
    'missing initial catalogue must fail closed until a verified retry');
  const catalogueHealthPoll = [...recoveredCatalogue.intervals.values()]
    .find(({ milliseconds }) => milliseconds === 20000);
  assert.ok(catalogueHealthPoll, 'catalogue recovery must reuse normal health polling');
  catalogueHealthPoll.callback();
  await settle();
  assert.equal(catalogueAttempts, 3,
    'periodic health tick must retry an unavailable catalogue');
  assert.equal(recoveredCatalogue.element('capacityText').textContent, 'Ready to browse',
    'successful reviewed catalogue retry must recover TV readiness');
  assert.equal(recoveredCatalogue.element('startButton').disabled, false,
    'successful site-list recovery must unlock Open automatically');
  assert.equal(recoveredCatalogue.element('urlInput').value, 'https://approved.test/',
    'recovered catalogue must populate its reviewed start URL');
  assert.equal(recoveredCatalogue.element('siteSuggestions').children.length, 1,
    'reviewed suggestions must be restored after an offline interval');
  assert.equal(recoveredCatalogue.element('formMessage').textContent, '',
    'successful recovery must clear stale catalogue-error guidance');

  // Two overlapping health calls and a BFCache return must share a single
  // in-flight catalogue request. Neither a forged ready status nor a delayed
  // read can enable session creation before the catalogue is verified.
  const slowCatalogue = deferred();
  let concurrentCalls = 0;
  const concurrentCatalogue = await bootPortal({
    siteRequest() {
      concurrentCalls++;
      return concurrentCalls <= 2
        ? response({ sites: [] })
        : slowCatalogue.promise;
    }
  });
  const concurrentHealthPoll = [...concurrentCatalogue.intervals.values()]
    .find(({ milliseconds }) => milliseconds === 20000);
  concurrentHealthPoll.callback();
  concurrentHealthPoll.callback();
  concurrentCatalogue.pageshow(true);
  await settle();
  assert.equal(concurrentCalls, 3,
    'overlapping health/BFCache retries must share one catalogue HTTP request');
  assert.equal(concurrentCatalogue.element('startButton').disabled, true,
    'an in-flight catalogue response may not unlock session admission');
  concurrentCatalogue.element('urlInput').value = 'https://approved.test/';
  concurrentCatalogue.submit();
  await settle();
  assert.equal(concurrentCatalogue.requests.filter(({ url }) => url === '/api/session').length, 0,
    'scripted submit during catalogue retry must not create a browser');
  slowCatalogue.resolve(response({
    sites: [{ name: 'Verified', url: 'https://approved.test/' }]
  }));
  await settle();
  assert.equal(concurrentCatalogue.element('startButton').disabled, false,
    'shared recovery success must unlock the real form once');
  assert.equal(concurrentCatalogue.element('capacityText').textContent, 'Ready to browse');
  assert.equal(concurrentCatalogue.element('siteSuggestions').children.length, 1);
  assert.equal(concurrentCalls, 3,
    'resolved shared catalogue retry must not create duplicate fetches');

  // The only guaranteed browser-side way to prevent a never-ending
  // catalogue GET from freezing initial health/poll setup is a bounded
  // AbortSignal. This harness triggers the abort deterministically without
  // waiting seven seconds; it exercises actual shipped app.js.
  let stalledSiteCalls = 0;
  const stalledCatalogue = await bootPortal({
    siteRequest(options) {
      stalledSiteCalls++;
      if (stalledSiteCalls === 1) {
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('request expired', 'TimeoutError')), { once: true });
        });
      }
      return response({ sites: [{ name: 'Recovered', url: 'https://approved.test/' }] });
    }
  });
  assert.equal(stalledCatalogue.element('startButton').disabled, true,
    'hanging bootstrap catalogue must not enable the TV start button');
  assert.equal(stalledCatalogue.timeoutControls.length, 1,
    'a hanging site request must have a bounded abort signal');
  stalledCatalogue.timeoutControls[0].abort();
  await settle();
  assert.equal(stalledSiteCalls, 2,
    'timed-out catalogue must retry during bootstrap health reconciliation');
  assert.equal(stalledCatalogue.element('capacityText').textContent, 'Ready to browse',
    'bounded site timeout must allow bootstrap health and catalogue recovery');
  assert.equal(stalledCatalogue.element('startButton').disabled, false,
    'healthy catalogued gateway must recover automatically after timed-out GET');
  assert.ok([...stalledCatalogue.intervals.values()].some(x => x.milliseconds === 20000),
    'after site request timeout, interval health polling must actually be installed');

  let healthCalls = 0;
  const hangingHealth = await bootPortal({
    healthRequest(options) {
      healthCalls++;
      if (healthCalls === 2) {
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('health timed out', 'TimeoutError')), { once: true });
        });
      }
      return response({ status: 'ok', activeSessions: 0, startingSessions: 0, capacity: 1 });
    }
  });
  const healthTimeoutPoll = [...hangingHealth.intervals.values()]
    .find(x => x.milliseconds === 20000);
  assert.ok(healthTimeoutPoll, 'a valid initial health must register polling');
  healthTimeoutPoll.callback();
  await settle();
  assert.equal(hangingHealth.timeoutControls.length, 3,
    'the stalled second health GET must have its own bounded timeout signal');
  hangingHealth.timeoutControls[2].abort();
  await settle();
  assert.equal(hangingHealth.element('capacityText').textContent, 'Browser engine offline',
    'timed-out health must replace stale green readiness with honest offline status');
  assert.equal(hangingHealth.element('startButton').disabled, true,
    'timed-out health must fail closed without issuing new browser starts');
  healthTimeoutPoll.callback();
  await settle();
  assert.equal(hangingHealth.element('capacityText').textContent, 'Ready to browse',
    'a later healthy response must recover automatically after health timeout');
  assert.equal(hangingHealth.element('startButton').disabled, false,
    'successful health retry should unlock the reviewed TV start again');

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

  // The TV portal should not waste a limited browser-start attempt or send
  // user-supplied credentials to the gateway when the URL is rejected by the
  // same reviewed HTTPS origin policy the server enforces (issues #266/#293).
  // Native browser form validation is not sufficient: scripted submits
  // bypass it, and username/password may hide inside a valid HTTPS URL.
  let manualStarts = 0;
  const reviewedUrlPortal = await bootPortal({
    sessionRequest: async () => {
      manualStarts++;
      return response(validSession);
    }
  });
  const rejectedManualUrls = [
    ['outside origin', 'https://outside.invalid/watch'],
    ['lookalike suffix', 'https://approved.test.attacker.invalid/'],
    ['deceptive userinfo host', 'https://approved.test@attacker.invalid/'],
    ['plain HTTP', 'http://approved.test/'],
    ['script scheme', 'javascript:alert(1)'],
    ['embedded credentials', 'https://user:pass@approved.test/watch'],
    ['encoded userinfo', 'https://us%65r@approved.test/watch'],
    ['password-only', 'https://:pass@approved.test/watch'],
    ['malformed URI', 'https://%zz@approved.test/']
  ];
  for (const [label, url] of rejectedManualUrls) {
    reviewedUrlPortal.element('urlInput').value = url;
    reviewedUrlPortal.submit();
    await settle();
    assert.equal(manualStarts, 0,
      label + ': unreviewed TV URL must never reach POST /api/session');
    assert.equal(reviewedUrlPortal.requests.filter(({ url: route }) =>
      route === '/api/session').length, 0,
    label + ': no gateway attempt may consume limiter quota');
    assert.match(reviewedUrlPortal.element('formMessage').textContent,
      /approved HTTPS website without credentials/,
      label + ': invalid URL must produce actionable local feedback');
    assert.equal(reviewedUrlPortal.element('startButton').disabled, false,
      label + ': normal form admission must stay usable');
  }
  reviewedUrlPortal.element('urlInput').value = 'https://approved.test/watch?quality=hd';
  reviewedUrlPortal.submit();
  await settle();
  assert.equal(manualStarts, 1,
    'reviewed HTTPS origin with a custom path and query must remain usable');
  const reviewedPost = reviewedUrlPortal.requests.filter(({ url }) =>
    url === '/api/session');
  assert.equal(reviewedPost.length, 1,
    'normal approved manual URL must allocate one browser');
  assert.equal(JSON.parse(reviewedPost[0].options.body).url,
    'https://approved.test/watch?quality=hd',
    'TV must preserve reviewed path and query exactly for gateway-side validation');

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

  // A late POST after pagehide can acquire a browser, but its keepalive
  // DELETE can fail while BFCache restores the same page. Preserve the token
  // for retry instead of making a new start reuse a still-live browser.
  const latePending = deferred();
  let lateFailedDeletes = 0;
  let lateAllocations = 0;
  const lateFailure = await bootPortal({
    sessionRequest() {
      lateAllocations++;
      return latePending.promise;
    },
    deleteRequest() {
      lateFailedDeletes++;
      return lateFailedDeletes === 1
        ? response({ error: 'Temporary gateway failure' }, 503)
        : response(null, 204);
    }
  });
  lateFailure.submit();
  lateFailure.pagehide();
  lateFailure.pageshow(true);
  latePending.resolve(response(validSession));
  await settle();
  assert.equal(lateFailedDeletes, 1,
    'abandoned late response must attempt exactly one initial keepalive DELETE');
  assert.equal(lateFailure.element('browserFrame').srcHistory.includes(validViewer), false,
    'abandoned late response may not mount the bearer iframe even on restore');
  assert.equal(lateFailure.element('startButton').disabled, true,
    'failed late DELETE must lock Open across BFCache restoration');
  assert.equal(lateFailure.element('capacityText').textContent,
    'Finishing previous browser session');
  assert.match(lateFailure.element('formMessage').textContent,
    /Retrying automatically/, 'failed late cleanup must have visible retry feedback');
  lateFailure.submit();
  await settle();
  assert.equal(lateAllocations, 1,
    'unreconciled late token must not allow another same-owner POST');
  const latePoll = [...lateFailure.intervals.values()].find(({ milliseconds }) =>
    milliseconds === 20000
  );
  assert.ok(latePoll, 'TV must retain health poll to reconcile a late issued token');
  latePoll.callback();
  await settle();
  assert.equal(lateFailedDeletes, 2, 'periodic health retries late session DELETE');
  assert.equal(lateFailure.element('startButton').disabled, false,
    'successful late cleanup unlocks a fresh start');
  assert.equal(lateFailure.element('formMessage').textContent, '',
    'confirmed late cleanup clears the retry warning');
  // Submit again: sessionRequest intentionally returns the same already
  // resolved fixture; only POST count matters for this positive guard.
  lateFailure.submit();
  await settle();
  assert.equal(lateAllocations, 2,
    'fresh start remains possible after failed late cleanup is reconciled');

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

  // A TV user must be able to enter and leave the real shipped fullscreen
  // handler without issuing another browser POST or replacing the iframe.
  // This uses the actual app.js listener and a stateful Fullscreen API fake:
  // a missing listener or inverted document.fullscreenElement check fails.
  const fullscreenPortal = await bootPortal({
    sessionRequest: async () => response(validSession)
  });
  fullscreenPortal.submit();
  await settle();
  assert.equal(fullscreenPortal.element('browserView').hidden, false,
    'fullscreen fixture requires an active browser');
  const toggleFullscreen = fullscreenPortal.element('fullscreenButton').listeners.click;
  assert.equal(typeof toggleFullscreen, 'function',
    'the TV fullscreen button must register an activation handler');
  await toggleFullscreen();
  assert.equal(fullscreenPortal.document.fullscreenElement,
    fullscreenPortal.element('browserView'),
    'fullscreen must include toolbar and end-session controls');
  assert.equal(fullscreenPortal.element('fullscreenButton').textContent, 'Exit fullscreen',
    'active fullscreen must announce a useful exit control');
  assert.equal(fullscreenPortal.element('fullscreenButton').getAttribute('aria-pressed'), 'true',
    'active fullscreen must expose its toggle state');
  await toggleFullscreen();
  assert.equal(fullscreenPortal.document.fullscreenElement, null,
    'second activation must exit fullscreen without losing the browser session');
  assert.deepEqual(fullscreenPortal.fullscreenEvents,
    ['enter:browserView', 'exit'],
    'fullscreen enter and exit must each invoke the correct browser API once');
  assert.equal(fullscreenPortal.element('fullscreenButton').textContent, 'Fullscreen',
    'exit control must return to the accessible default label');
  assert.equal(fullscreenPortal.element('fullscreenButton').getAttribute('aria-pressed'), 'false',
    'fullscreen toggle must reset aria-pressed after exit');
  assert.equal(fullscreenPortal.element('browserFrame').src, validViewer,
    'fullscreen toggling must preserve the authenticated viewer iframe');
  assert.equal(fullscreenPortal.requests.filter(({ url }) =>
    url === '/api/session').length, 1,
  'fullscreen toggling must never allocate another gateway browser');
  await toggleFullscreen();
  assert.equal(fullscreenPortal.document.fullscreenElement,
    fullscreenPortal.element('browserView'), 'end-in-fullscreen fixture must be active');
  await fullscreenPortal.element('endButton').listeners.click();
  assert.equal(fullscreenPortal.document.fullscreenElement, null,
    'ending a fullscreen session must exit fullscreen before hiding the viewer');
  assert.equal(fullscreenPortal.element('browserView').hidden, true,
    'End must release the live session without requiring a prior fullscreen exit');
  assert.deepEqual(fullscreenPortal.fullscreenEvents,
    ['enter:browserView', 'exit', 'enter:browserView', 'exit'],
    'End in fullscreen must call exitFullscreen exactly once');

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
  assert.equal(overlapping.element('capacityText').textContent,
    'Finishing previous browser session',
    'a pending DELETE must immediately replace stale green Ready text');
  assert.equal(overlapping.element('capacityText').parentElement.className, 'status',
    'a pending DELETE must clear stale green readiness styling');
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

  // A 503 or lost DELETE must not be treated as successful teardown.
  // Only an explicit confirmation (including already-gone 404/410) may
  // unlock another same-IP browser start, even if health reports "ok".
  let recoverDeletes = 0;
  let failedAllocations = 0;
  const pendingRecovered = deferred();
  const failedRelease = await bootPortal({
    sessionRequest: async () => {
      failedAllocations++;
      return response(validSession);
    },
    deleteRequest() {
      recoverDeletes++;
      return recoverDeletes === 1
        ? response({ error: 'Temporary gateway failure' }, 503)
        : pendingRecovered.promise;
    }
  });
  failedRelease.submit();
  await settle();
  await failedRelease.element('endButton').listeners.click();
  await settle();
  assert.equal(failedRelease.element('browserFrame').src, 'about:blank',
    'failed end must still discard the bearer viewer');
  assert.equal(failedRelease.element('browserView').hidden, true);
  assert.equal(failedRelease.element('startButton').disabled, true,
    'failed DELETE must keep Open locked even when health is nominally ready');
  assert.equal(failedRelease.element('capacityText').textContent,
    'Finishing previous browser session',
    'uncertain deletion must not claim Ready on a healthy gateway');
  assert.match(failedRelease.element('formMessage').textContent,
    /Retrying automatically/,
    'failed DELETE should tell a TV user that cleanup is pending');
  failedRelease.submit();
  await settle();
  assert.equal(failedAllocations, 1,
    'scripted submit cannot reuse old bearer after DELETE failure');
  const releasePoll = [...failedRelease.intervals.values()].find(({ milliseconds }) =>
    milliseconds === 20000
  );
  assert.ok(releasePoll, 'gateway health interval must remain available for retry');
  releasePoll.callback();
  await settle();
  assert.equal(recoverDeletes, 2, 'periodic health must retry failed DELETE exactly once');
  releasePoll.callback();
  await settle();
  assert.equal(recoverDeletes, 2, 'overlapping polls must not double-send DELETE');
  assert.equal(failedRelease.element('startButton').disabled, true,
    'concurrent health requests cannot unlock pending teardown');
  pendingRecovered.resolve(response(null, 204));
  await settle();
  assert.equal(failedRelease.element('startButton').disabled, false,
    'confirmed deletion must restore a usable start button');
  assert.equal(failedRelease.element('formMessage').textContent, '',
    'successful cleanup must clear temporary error message');
  failedRelease.submit();
  await settle();
  assert.equal(failedAllocations, 2, 'new browser allocation works after retry succeeds');

  // A failed fetch() has no status code at all (TCP reset / offline).
  // It must be at least as fail-closed as an explicit HTTP 503, while the
  // next existing health interval can reconcile a successful retry.
  let transportDeletes = 0;
  let transportStarts = 0;
  const transportDown = await bootPortal({
    sessionRequest: async () => {
      transportStarts++;
      return response(validSession);
    },
    deleteRequest() {
      transportDeletes++;
      if (transportDeletes === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return response(null, 204);
    }
  });
  transportDown.submit();
  await settle();
  await transportDown.element('endButton').listeners.click();
  await settle();
  assert.equal(transportDown.element('startButton').disabled, true,
    'transport-failed DELETE must not release browser admission');
  assert.equal(transportDown.element('capacityText').textContent,
    'Finishing previous browser session');
  transportDown.submit();
  await settle();
  assert.equal(transportStarts, 1,
    'transport failure must not allow immediate reuse of a possibly live token');
  const transportPoll = [...transportDown.intervals.values()].find(({ milliseconds }) =>
    milliseconds === 20000
  );
  transportPoll.callback();
  await settle();
  assert.equal(transportDeletes, 2,
    'regular health poll should reconcile a transport-failed session delete');
  assert.equal(transportDown.element('startButton').disabled, false);
  transportDown.submit();
  await settle();
  assert.equal(transportStarts, 2,
    'successful retry after transport error must restore browser admission');

  // The gateway may already have removed the token, making a subsequent
  // release idempotently return HTTP 404; that is safe to reconcile.
  let goneAllocations = 0;
  const alreadyGone = await bootPortal({
    sessionRequest: async () => {
      goneAllocations++;
      return response(validSession);
    },
    deleteRequest: async () => response({ error: 'Session not found.' }, 404)
  });
  alreadyGone.submit();
  await settle();
  await alreadyGone.element('endButton').listeners.click();
  await settle();
  assert.equal(alreadyGone.element('startButton').disabled, false,
    'already-missing bearer is safe to discard without an infinite lock');
  alreadyGone.submit();
  await settle();
  assert.equal(goneAllocations, 2, '404 cleanup must permit fresh browser after prior session is gone');

  // An expired lease may respond 410 rather than 404 when End retries an
  // already-revoked token. Both must be idempotent cleanup confirmations.
  const leaseGone = await bootPortal({
    sessionRequest: async () => response(validSession),
    deleteRequest: async () => response({ error: 'Session expired.' }, 410)
  });
  leaseGone.submit();
  await settle();
  await leaseGone.element('endButton').listeners.click();
  await settle();
  assert.equal(leaseGone.element('browserFrame').src, 'about:blank');
  assert.equal(leaseGone.element('startButton').disabled, false,
    '410 must confirm the old session is gone without locking TV admission');
  assert.equal(leaseGone.element('formMessage').textContent, '',
    '410 must not look like an unresolved transport failure');

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
    const validIssuedToken = typeof payload?.token === 'string' &&
      /^[A-Za-z0-9_-]{32}$/.test(payload.token);
    const cleanupRequests = candidate.requests.filter(({ url, options }) =>
      url === '/api/session/' + validToken && options.method === 'DELETE');
    assert.equal(cleanupRequests.length, validIssuedToken ? 1 : 0,
      label + ': reject the unsafe viewer but release only a syntactically valid minted token');
    if (validIssuedToken) assert.equal(cleanupRequests[0].options.keepalive, true,
      label + ': malformed successful browser start must use keepalive cleanup');
  }

  // If an invalid viewer response carries a valid gateway token but its
  // DELETE fails, the response rejection must not create an invisible,
  // still-allocated browser that a new POST can inadvertently reuse.
  let rejectedDeletes = 0;
  let rejectedStarts = 0;
  const rejectedViewer = await bootPortal({
    sessionRequest: async () => {
      rejectedStarts++;
      return response({ ...validSession, viewerUrl: 'https://untrusted.example/' });
    },
    deleteRequest: async () => {
      rejectedDeletes++;
      return rejectedDeletes === 1
        ? response({ error: 'Gateway unavailable' }, 503)
        : response(null, 204);
    }
  });
  rejectedViewer.element('browserView').hidden = true;
  rejectedViewer.submit();
  await settle();
  assert.equal(rejectedDeletes, 1, 'invalid response must release minted bearer immediately');
  assert.equal(rejectedViewer.element('browserView').hidden, true);
  assert.equal(rejectedViewer.element('browserFrame').srcHistory.includes(validViewer), false);
  assert.equal(rejectedViewer.element('startButton').disabled, true,
    'failed cleanup of invalid payload must fail closed');
  assert.match(rejectedViewer.element('formMessage').textContent, /Retrying automatically/);
  rejectedViewer.submit();
  await settle();
  assert.equal(rejectedStarts, 1, 'failed cleanup cannot be bypassed through form submit');
  const rejectedPoll = [...rejectedViewer.intervals.values()].find(({ milliseconds }) =>
    milliseconds === 20000
  );
  rejectedPoll.callback();
  await settle();
  assert.equal(rejectedDeletes, 2, 'normal health poll must retry malformed-viewer cleanup');
  assert.equal(rejectedViewer.element('startButton').disabled, false,
    'successful release restores new browser admission');

  console.log('zBrowse portal capacity, ordered health polls, admission, payload and page-exit teardown validated');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
