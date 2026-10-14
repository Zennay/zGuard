// Read-only production routing acceptance for issue #293.
// Never creates browser sessions, requests /s/ tokens, or exports session state.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

// The API must represent the audited sites shipped with this exact checkout,
// not just *any* HTTPS website claiming to be a curated entry.
const reviewedSites = JSON.parse(fs.readFileSync(
  new URL('../zbrowse/gateway/config/sites.json', import.meta.url), 'utf8'
));
assert.ok(Array.isArray(reviewedSites) && reviewedSites.length > 0,
  'reviewed site catalogue must not be empty');
const reviewedByUrl = new Map(reviewedSites.map((site) => [site.url, site.name]));
assert.equal(reviewedByUrl.size, reviewedSites.length,
  'reviewed catalogue may not contain duplicate URLs');

const PUBLIC_ORIGIN = 'https://zbrowse-tv.lizellay.chatgpt.site/';

function assertPublicOrigin(raw) {
  const url = new URL(raw);
  assert.equal(url.href, PUBLIC_ORIGIN, 'readiness can only probe the reviewed public TV origin');
  assert.equal(url.protocol, 'https:', 'public readiness must use HTTPS');
  assert.equal(url.username, '', 'public readiness cannot include URL credentials');
  assert.equal(url.password, '', 'public readiness cannot include URL credentials');
  return url;
}

function requireCount(value, name, minimum = 0) {
  assert.ok(
    Number.isSafeInteger(value) && value >= minimum,
    name + ' must be an integer >= ' + minimum
  );
}

// Cache-Status is a Structured Fields member list. An intermediary can
// report a hit as a bare flag, hit=?1, or another truthy/unknown value.
// Only an explicit false marker is not evidence of cached health.
function reportsCacheHit(value) {
  return value.split(/[;,]/).some(part => {
    const match = /^hit(?:\s*=\s*(.*))?$/i.exec(part.trim());
    if (!match) return false;
    return match[1] === undefined ||
      !['?0', '0', 'false'].includes(match[1].trim().toLowerCase());
  });
}

async function getJson(origin, route, fetcher) {
  const url = new URL(route, origin);
  assert.equal(url.origin, origin.origin, 'readiness must never leave the public origin');
  // No redirects: a static hosting redirect must not be mistaken for a real
  // same-origin gateway reverse proxy. No cookies or bearer tokens are sent.
  const response = await fetcher(url.href, {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(7000)
  });
  // Even a refused HTTP status, HTML fallback or cached capacity snapshot
  // may have a still-open response stream: stop it before failing readiness.
  try {
    // The production gateway's two public JSON GETs return exactly 200.
    // Merely checking Response.ok would also accept a 202 placeholder or a
    // 206 partial response from an incorrect CDN/proxy route as live readiness.
    assert.equal(response.status, 200,
      route + ': API must return exactly HTTP 200, got HTTP ' + response.status);
    assert.match(
      response.headers.get('content-type') || '',
      /^application\/json(?:\s*;|$)/i,
      route + ': API must return JSON, not a static-site HTML fallback'
    );
    if (route === '/api/health') {
      // Request cache: no-store is only a client preference, not proof of
      // server/reverse-proxy policy. This is a live-capacity status endpoint:
      // stale cached "ok" must never certify production browser readiness.
      const directives = (response.headers.get('cache-control') || '')
        .split(',').map(directive => directive.trim().toLowerCase());
      assert.ok(directives.includes('no-store'),
        '/api/health: server must declare Cache-Control: no-store');
      assert.equal(directives.includes('public'), false,
        '/api/health: must not allow public response caching');
      // no-store on an origin response is necessary, but not enough to prove an
      // intermediary did not actually replay a cached capacity observation.
      const age = response.headers.get('age');
      if (age !== null) {
        assert.match(age, /^[0-9]+$/, '/api/health: malformed cache Age header');
        assert.equal(BigInt(age), 0n,
          '/api/health: cached Age must be zero for live browser capacity');
      }
      const cacheStatus = response.headers.get('cache-status') || '';
      assert.equal(reportsCacheHit(cacheStatus), false,
        '/api/health: intermediary Cache-Status reports a cache hit');
      const cloudflareStatus = response.headers.get('cf-cache-status') || '';
      assert.doesNotMatch(cloudflareStatus, /^(?:hit|stale|updating|revalidated)$/i,
        '/api/health: intermediary CF-Cache-Status reports cached content');
      const xCache = response.headers.get('x-cache') || '';
      // Vendor markers include TCP_HIT, RefreshHit and HIT; matching only
      // whitespace-delimited "HIT" misses common cached responses.
      assert.doesNotMatch(xCache, /hit/i,
        '/api/health: intermediary X-Cache reports a cache hit');
    }
  } catch (error) {
    try { await response.body?.cancel(); } catch { /* Keep the primary policy failure. */ }
    throw error;
  }
  // A misrouted public endpoint can stream arbitrarily large JSON or stall
  // while drip-feeding bytes. Bound the decoded response, not just headers.
  // AbortSignal.timeout above also applies while consuming the actual body.
  const maximumBytes = route === '/api/health' ? 4096 : 65536;
  const length = response.headers.get('content-length');
  try {
    if (length !== null) {
      assert.match(length, /^[0-9]+$/, route + ': invalid Content-Length header');
      assert.ok(BigInt(length) <= BigInt(maximumBytes),
        route + ': advertised JSON body exceeds ' + maximumBytes + ' bytes');
    }
  } catch (error) {
    // Reject on advertised size before reading a single byte. Cancel the
    // source as well so a misrouted public gateway cannot keep downloading.
    try { await response.body?.cancel(); } catch { /* Preserve the original failure. */ }
    throw error;
  }
  assert.ok(response.body, route + ': gateway JSON response body is missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let decoded = '';
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        throw new Error(route + ': JSON body exceeds ' + maximumBytes + ' bytes');
      }
      decoded += decoder.decode(value, { stream: true });
    }
    decoded += decoder.decode();
  } catch (error) {
    // Oversized chunks, invalid UTF-8 and stream failures must stop the
    // transfer before releasing the lock. Cancellation may itself reject.
    try { await reader.cancel(); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  let data;
  try {
    data = JSON.parse(decoded);
  } catch {
    throw new Error(route + ': gateway sent invalid JSON');
  }
  assert.ok(data && typeof data === 'object' && !Array.isArray(data),
    route + ': gateway must return a JSON object');
  return data;
}

export async function checkPublicReadiness(fetcher = globalThis.fetch, rawOrigin = PUBLIC_ORIGIN) {
  const origin = assertPublicOrigin(rawOrigin);
  const health = await getJson(origin, '/api/health', fetcher);
  assert.equal(health.status, 'ok', 'gateway health status must equal ok');
  requireCount(health.activeSessions, 'activeSessions');
  requireCount(health.startingSessions, 'startingSessions');
  requireCount(health.capacity, 'capacity', 1);
  assert.ok(health.activeSessions + health.startingSessions <= health.capacity,
    'live gateway must not report overcapacity');

  const listed = await getJson(origin, '/api/sites', fetcher);
  requireCount(listed.maxSessionMinutes, 'maxSessionMinutes', 1);
  assert.ok(Array.isArray(listed.sites) && listed.sites.length > 0,
    'curated site list must contain at least one entry');
  for (const site of listed.sites) {
    assert.ok(site && typeof site.name === 'string' && site.name.trim(),
      'curated site must have a readable name');
    assert.equal(typeof site.url, 'string', 'curated site must have a URL string');
    const target = new URL(site.url);
    assert.equal(target.protocol, 'https:', 'curated site must use HTTPS');
    assert.equal(target.username, '', 'curated site must not embed credentials');
    assert.equal(target.password, '', 'curated site must not embed credentials');
  }
  // A static/mock JSON endpoint can report status ok while serving unrelated
  // links. Require the same site identities as the checked-out gateway policy.
  assert.equal(listed.sites.length, reviewedSites.length,
    'public catalogue must match the reviewed site count');
  const seenSiteUrls = new Set();
  for (const site of listed.sites) {
    assert.ok(reviewedByUrl.has(site.url),
      'public catalogue contains an unreviewed site URL');
    assert.equal(site.name, reviewedByUrl.get(site.url),
      'public catalogue must preserve the reviewed site identity');
    assert.equal(seenSiteUrls.has(site.url), false,
      'public catalogue must not repeat a reviewed site');
    seenSiteUrls.add(site.url);
  }

  return {
    connected: true,
    available: health.activeSessions + health.startingSessions < health.capacity,
    capacity: health.capacity,
    activeSessions: health.activeSessions,
    startingSessions: health.startingSessions,
    siteCount: listed.sites.length,
    maxSessionMinutes: listed.maxSessionMinutes
  };
}

const sampleHealth = { status: 'ok', activeSessions: 0, startingSessions: 0, capacity: 1 };
const sampleSites = {
  sites: reviewedSites.map(({ name, url }) => ({ name, url })),
  maxSessionMinutes: 15
};

function response(value, status = 200, contentType = 'application/json; charset=utf-8',
  cacheControl = 'no-store', extraHeaders = {}) {
  return new Response(contentType.startsWith('application/json') ? JSON.stringify(value) : '<html>Offline</html>', {
    status,
    headers: {
      'content-type': contentType,
      ...(cacheControl === null ? {} : { 'cache-control': cacheControl }),
      ...extraHeaders
    }
  });
}

// Real TCP loopback evidence: a rejected response must close the underlying
// transfer, not merely reject an in-memory Response or release a reader lock.
// The fetcher rewrites ONLY test requests to 127.0.0.1; no public HTTP, real
// session, /s/ token, browser allocation or production interaction occurs.
async function testRealLoopbackCancellation() {
  let scenario = null;
  const observedRoutes = [];
  const server = http.createServer((req, res) => {
    observedRoutes.push({ method: req.method, url: req.url });
    if (req.method !== 'GET' || !['/api/health', '/api/sites'].includes(req.url)) {
      res.writeHead(405, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (scenario && req.url === scenario.path) {
      const active = scenario;
      res.once('close', () => { active.closed = true; });
      res.writeHead(active.status, {
        'content-type': active.contentType,
        'cache-control': 'no-store',
        ...active.headers
      });
      res.write(active.bytes);
      // Intentionally never end the invalid stream. Only client-side abort
      // can release this connection before the safety timeout.
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify(req.url === '/api/health' ? sampleHealth : sampleSites));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const loopback = 'http://127.0.0.1:' + server.address().port;
  const loopbackFetch = (raw, options) => {
    const url = new URL(raw);
    assert.equal(url.origin, new URL(PUBLIC_ORIGIN).origin,
      'only the reviewed public origin may be mapped to this loopback fixture');
    assert.ok(['/api/health', '/api/sites'].includes(url.pathname),
      'only the two read-only readiness endpoints may be tested over loopback');
    assert.equal(options.method, 'GET', 'real TCP acceptance must never create a session');
    assert.equal(options.credentials, 'omit', 'real TCP acceptance cannot send credentials');
    return fetch(loopback + url.pathname, options);
  };
  try {
    for (const [name, path, status, contentType, headers, bytes, error] of [
      ['oversized declared health', '/api/health', 200, 'application/json',
        { 'content-length': '999999' }, '{"status":"ok"}',
        /advertised JSON body exceeds 4096 bytes/],
      ['malformed UTF-8 health', '/api/health', 200, 'application/json', {},
        Buffer.from([0xc3, 0x28]), /encoded data was not valid|UTF-8|not valid/i],
      ['rejected sites status', '/api/sites', 503, 'application/json', {},
        '{"error":"unavailable"}', /exactly HTTP 200/],
      ['HTML sites fallback', '/api/sites', 200, 'text/html', {},
        '<html>static fallback</html>', /must return JSON/],
      ['streamed oversized sites', '/api/sites', 200, 'application/json', {},
        Buffer.alloc(65537, 32), /JSON body exceeds 65536 bytes/]
    ]) {
      scenario = { name, path, status, contentType, headers, bytes, closed: false };
      const active = scenario;
      await assert.rejects(checkPublicReadiness(loopbackFetch), error,
        name + ': real TCP response must fail the release gate');
      // Wait only for transport teardown observed by the server, not a fake
      // JavaScript cancellation counter.
      for (let tries = 0; tries < 60 && !active.closed; tries++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(active.closed, true,
        name + ': abort must close the real HTTP response within 3 seconds');
    }
    // A server that sends valid headers and one JSON whitespace byte but
    // never finishes must not leave a readiness probe hanging indefinitely.
    // Use a separate 11s test watchdog: it detects regressions but cannot
    // masquerade as the shipped 7s AbortSignal.timeout from getJson().
    for (const path of ['/api/health', '/api/sites']) {
      scenario = {
        name: 'stalled real TCP response', path, status: 200,
        contentType: 'application/json', headers: {}, bytes: ' ', closed: false
      };
      const active = scenario;
      let watchdog;
      const began = Date.now();
      try {
        const bounded = Promise.race([
          checkPublicReadiness(loopbackFetch),
          new Promise((_, reject) => {
            watchdog = setTimeout(() =>
              reject(new Error('test watchdog expired without client abort')), 11000);
          })
        ]);
        await assert.rejects(bounded, /aborted|time(?:d)? ?out/i,
          path + ': a stalled real TCP JSON body must expire via client signal');
      } finally {
        clearTimeout(watchdog);
      }
      const elapsed = Date.now() - began;
      assert.ok(elapsed >= 5500 && elapsed < 10500,
        path + ': stalled response must expire near the 7s client deadline, got ' + elapsed);
      for (let tries = 0; tries < 60 && !active.closed; tries++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(active.closed, true,
        path + ': timed-out client must close the real HTTP stream');
    }
    scenario = null;
    const recovered = await checkPublicReadiness(loopbackFetch);
    assert.equal(recovered.connected, true,
      'ordinary uncached real HTTP readiness must recover after rejected transfers');
    assert.equal(recovered.available, true);
    assert.ok(observedRoutes.length >= 7);
    assert.ok(observedRoutes.every(({ method, url }) =>
      method === 'GET' && ['/api/health', '/api/sites'].includes(url)),
    'loopback proof must never send POST, session tokens or other API routes');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function selfTest() {
  const requested = [];
  const healthy = async (url, options) => {
    requested.push({
      url, method: options.method, redirect: options.redirect,
      credentials: options.credentials, referrerPolicy: options.referrerPolicy,
      cache: options.cache, hasAuth: Object.keys(options.headers ?? {})
        .some((name) => /authorization|cookie/i.test(name))
    });
    if (url.endsWith('/api/health')) return response(sampleHealth);
    if (url.endsWith('/api/sites')) return response(sampleSites);
    throw new Error('unexpected endpoint');
  };
  const normal = await checkPublicReadiness(healthy);
  assert.equal(normal.connected, true);
  assert.equal(normal.available, true);
  assert.equal(normal.siteCount, 1);
  assert.deepEqual(requested.map(({ url }) => new URL(url).pathname), ['/api/health', '/api/sites']);
  assert.ok(requested.every(({ method, redirect, credentials, referrerPolicy, cache, hasAuth }) =>
    method === 'GET' && redirect === 'error' && credentials === 'omit' &&
    referrerPolicy === 'no-referrer' && cache === 'no-store' && !hasAuth),
    'readiness must be GET-only, uncached, redirect-free and credential/referrer-free');

  const busy = await checkPublicReadiness(async (url) =>
    url.endsWith('/api/health')
      ? response({ ...sampleHealth, activeSessions: 1 })
      : response(sampleSites));
  assert.equal(busy.connected, true, 'busy is not offline');
  assert.equal(busy.available, false, 'full capacity must be reported as busy');

  const httpJson = (text, headers = {}) => new Response(text, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    }
  });
  // Prove size limits on both endpoints and on the actual streamed bytes.
  // The probes must never need to allocate a browser or issue a token.
  await assert.rejects(checkPublicReadiness(async () =>
    httpJson(JSON.stringify(sampleHealth), { 'content-length': '9999999999999999999999' })),
  /advertised JSON body exceeds 4096 bytes/);
  await assert.rejects(checkPublicReadiness(async () =>
    httpJson(JSON.stringify(sampleHealth), { 'content-length': 'invalid' })),
  /invalid Content-Length header/);
  await assert.rejects(checkPublicReadiness(async () =>
    httpJson(' '.repeat(4097) + JSON.stringify(sampleHealth))),
  /JSON body exceeds 4096 bytes/);
  await assert.rejects(checkPublicReadiness(async url =>
    url.endsWith('/api/health') ? response(sampleHealth)
      : httpJson(JSON.stringify({ ...sampleSites, filler: 'X'.repeat(66000) }))),
  /JSON body exceeds 65536 bytes/);

  // Reject invalid metadata before consuming even one body byte, for BOTH
  // health and catalog readiness. Proxy HTML/errors/cache hits often stream
  // substantial bodies and must not continue after a failed release gate.
  for (const route of ['/api/health', '/api/sites']) {
    for (const [kind, status, contentType, cacheControl, extraHeaders, expected] of [
      ['HTTP failure', 503, 'application/json', 'no-store', {}, /exactly HTTP 200/],
      ['noncanonical 2xx', 202, 'application/json', 'no-store', {}, /exactly HTTP 200/],
      ['HTML fallback', 200, 'text/html', 'no-store', {}, /must return JSON/],
      ...(route === '/api/health' ? [
        ['missing no-store', 200, 'application/json', null, {},
          /must declare Cache-Control: no-store/],
        ['cached response', 200, 'application/json', 'no-store',
          { 'cache-status': 'edge; hit' }, /Cache-Status reports a cache hit/]
      ] : [])
    ]) {
      let reads = 0;
      let cancellations = 0;
      const bad = new Response(new ReadableStream({
        pull() { reads++; throw new Error('invalid metadata must not read body'); },
        cancel() { cancellations++; }
      }, { highWaterMark: 0 }), {
        status,
        headers: {
          'content-type': contentType,
          ...(cacheControl === null ? {} : { 'cache-control': cacheControl }),
          ...extraHeaders
        }
      });
      await assert.rejects(checkPublicReadiness(async url =>
        url.endsWith(route) ? bad : response(sampleHealth)), expected,
      route + ' ' + kind + ' must reject unsafe response metadata');
      assert.equal(reads, 0, route + ' ' + kind + ' must reject before reading');
      assert.equal(cancellations, 1, route + ' ' + kind + ' must cancel the stream');
    }
  }
  // Prove early cancellation for both public readiness GETs. This must
  // stop an untrusted stream (not merely fail the readiness JSON assertion).
  for (const route of ['/api/health', '/api/sites']) {
    for (const [kind, bodyBytes, headers, expected] of [
      ['declared oversized', '{"status":"ok"}', { 'content-length': '999999' },
        /advertised JSON body exceeds/],
      ['invalid declared length', '{"status":"ok"}', { 'content-length': 'NaN' },
        /invalid Content-Length/],
      ['received oversized', ' '.repeat(route === '/api/health' ? 4097 : 65537),
        {}, /JSON body exceeds/],
      ['malformed UTF-8', new Uint8Array([0xc3, 0x28]), {},
        /encoded data was not valid|UTF-8|not valid/i]
    ]) {
      let cancellations = 0;
      let readAttempts = 0;
      const bad = new Response(new ReadableStream({
        pull(controller) {
          readAttempts++;
          if (readAttempts === 1) {
            controller.enqueue(typeof bodyBytes === 'string'
              ? new TextEncoder().encode(bodyBytes) : bodyBytes);
          } else {
            // The intentionally unending remainder must never be consumed.
            throw new Error('follow-on stream unexpectedly consumed');
          }
        },
        cancel() { cancellations++; }
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
      const fetcher = async url => url.endsWith(route) ? bad : response(sampleHealth);
      await assert.rejects(checkPublicReadiness(fetcher), expected,
        route + ' ' + kind + ' must fail closed');
      assert.equal(cancellations, 1, route + ' ' + kind + ' must cancel the response body');
      assert.equal(readAttempts, kind.includes('declared') ? 0 : 1,
        route + ' ' + kind + ' must not read unexpected follow-on bytes');
    }
  }
  // Cancellation errors cannot hide the genuine oversized-header rejection.
  const rejectsCancel = new Response(new ReadableStream({
    cancel() { throw new Error('synthetic cancellation exception'); }
  }), { headers: { 'content-type': 'application/json',
    'cache-control': 'no-store', 'content-length': '999999' } });
  await assert.rejects(checkPublicReadiness(async () => rejectsCancel),
    /advertised JSON body exceeds 4096 bytes/);

  const streamedOversize = async url => url.endsWith('/api/health')
    ? response(sampleHealth)
    : new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(' '.repeat(35000)));
        controller.enqueue(new TextEncoder().encode(' '.repeat(35000)));
        controller.close();
      }
    }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(checkPublicReadiness(streamedOversize),
    /JSON body exceeds 65536 bytes/, 'unknown-length streamed JSON must be bounded');
  await assert.rejects(checkPublicReadiness(async () =>
    httpJson('{ definitely not json }')), /gateway sent invalid JSON/);


  // The production probe must independently verify server cache policy,
  // even though the read-only HTTP client sets cache: "no-store" itself.
  // Fail before checking sites if a purported healthy gateway could be stale.
  for (const [label, cacheControl, expected] of [
    ['missing header', null, /must declare Cache-Control: no-store/],
    ['no-cache is not no-store', 'private, no-cache', /must declare Cache-Control: no-store/],
    ['directives must not match by substring', 'no-store=false',
      /must declare Cache-Control: no-store/],
    ['public and no-store conflict', 'public, no-store',
      /must not allow public response caching/]
  ]) {
    let inspectedSites = false;
    await assert.rejects(checkPublicReadiness(async url => {
      if (url.endsWith('/api/health')) {
        return response(sampleHealth, 200, 'application/json; charset=utf-8', cacheControl);
      }
      inspectedSites = true;
      return response(sampleSites);
    }), expected, label + ': unsafe cache policy must fail public release check');
    assert.equal(inspectedSites, false,
      label + ': a failed health cache policy must stop before site catalogue');
  }
  assert.equal((await checkPublicReadiness(async url =>
    url.endsWith('/api/health')
      ? response(sampleHealth, 200, 'application/json; charset=utf-8', 'private, No-Store')
      : response(sampleSites))).connected, true,
  'case-insensitive no-store with private directive must remain acceptable');

  // A proxy/CDN may accidentally serve stale health even while forwarding
  // Cache-Control: no-store. Reject explicit evidence that it already cached.
  for (const [label, headers, expected] of [
    ['positive Age', { age: '12' }, /cached Age must be zero/],
    ['invalid Age', { age: 'NaN' }, /malformed cache Age header/],
    ['standard Cache-Status hit', { 'cache-status': 'edge; hit; ttl=30' },
      /Cache-Status reports a cache hit/],
    ['Cache-Status boolean hit', { 'cache-status': 'edge; hit=?1; ttl=30' },
      /Cache-Status reports a cache hit/],
    ['Cache-Status truthy hit assignment', { 'cache-status': 'edge; hit=true' },
      /Cache-Status reports a cache hit/],
    ['Cache-Status ambiguous hit assignment', { 'cache-status': 'edge; hit=unknown' },
      /Cache-Status reports a cache hit/],
    ['CDN stale', { 'cf-cache-status': 'STALE' },
      /CF-Cache-Status reports cached content/],
    ['CDN hit', { 'cf-cache-status': 'HIT' },
      /CF-Cache-Status reports cached content/],
    ['intermediary hit', { 'x-cache': 'TCP_HIT, HIT' },
      /X-Cache reports a cache hit/],
    ['intermediary standalone TCP_HIT', { 'x-cache': 'TCP_HIT' },
      /X-Cache reports a cache hit/],
    ['intermediary refresh-hit marker', { 'x-cache': 'RefreshHit' },
      /X-Cache reports a cache hit/]
  ]) {
    let sitesRead = false;
    await assert.rejects(checkPublicReadiness(async url => {
      if (url.endsWith('/api/health')) {
        return response(sampleHealth, 200, 'application/json; charset=utf-8',
          'no-store', headers);
      }
      sitesRead = true;
      return response(sampleSites);
    }), expected, label + ': no cache evidence may be reported as live health');
    assert.equal(sitesRead, false,
      label + ': fail before the site catalogue on cached health');
  }
  assert.equal((await checkPublicReadiness(async url =>
    url.endsWith('/api/health')
      ? response(sampleHealth, 200, 'application/json; charset=utf-8', 'no-store', {
        age: '0', 'cache-status': 'edge; hit=?0; fwd=miss',
        'cf-cache-status': 'DYNAMIC', 'x-cache': 'MISS'
      })
      : response(sampleSites))).connected, true,
  'uncached responses must remain accepted with ordinary cache diagnostics');

  await assert.rejects(checkPublicReadiness(async () => response({}, 503)), /HTTP 503/);
  for (const code of [201, 202, 206]) {
    await assert.rejects(checkPublicReadiness(async (url) =>
      url.endsWith('/api/health') ? response(sampleHealth, code) : response(sampleSites)),
    new RegExp('api/health: API must return exactly HTTP 200, got HTTP ' + code),
    'health response must not accept noncanonical successful HTTP ' + code);
    await assert.rejects(checkPublicReadiness(async (url) =>
      url.endsWith('/api/health') ? response(sampleHealth) : response(sampleSites, code)),
    new RegExp('api/sites: API must return exactly HTTP 200, got HTTP ' + code),
    'catalogue response must not accept noncanonical successful HTTP ' + code);
  }
  await assert.rejects(checkPublicReadiness(async () =>
    response({}, 200, 'text/html')), /static-site HTML fallback/);
  // Even correct JSON and HTTP 200 are not sufficient to certify a
  // running browser gateway. Reject draining, inconsistent and ill-typed
  // capacity observations before checking the (otherwise valid) site list.
  const invalidHealth = [
    ['draining gateway', { ...sampleHealth, status: 'draining' }, /status must equal ok/],
    ['missing readiness state', { ...sampleHealth, status: undefined }, /status must equal ok/],
    ['negative active count', { ...sampleHealth, activeSessions: -1 }, /activeSessions must be an integer/],
    ['fractional pending count', { ...sampleHealth, startingSessions: 0.5 }, /startingSessions must be an integer/],
    ['zero capacity', { ...sampleHealth, capacity: 0 }, /capacity must be an integer/],
    ['unsafe capacity number', { ...sampleHealth, capacity: Number.MAX_SAFE_INTEGER + 1 },
      /capacity must be an integer/],
    ['overbooked capacity', { ...sampleHealth, activeSessions: 1, startingSessions: 1 },
      /must not report overcapacity/],
    ['string pending count', { ...sampleHealth, startingSessions: '0' },
      /startingSessions must be an integer/]
  ];
  for (const [label, health, error] of invalidHealth) {
    let sitesRead = false;
    await assert.rejects(checkPublicReadiness(async (url) => {
      if (url.endsWith('/api/health')) return response(health);
      sitesRead = true;
      return response(sampleSites);
    }), error, label + ': invalid health must fail closed');
    assert.equal(sitesRead, false,
      label + ': do not probe catalogue after failed gateway health');
  }

  await assert.rejects(checkPublicReadiness(async (url) =>
    url.endsWith('/api/health') ? response({ ...sampleHealth, capacity: '1' }) : response(sampleSites)),
  /capacity must be an integer/);
  await assert.rejects(checkPublicReadiness(async (url) =>
    url.endsWith('/api/health') ? response(sampleHealth) : response({ ...sampleSites, maxSessionMinutes: undefined })),
  /maxSessionMinutes must be an integer/);
  await assert.rejects(checkPublicReadiness(async (url) =>
    url.endsWith('/api/health') ? response(sampleHealth) : response({ ...sampleSites, sites: [] })),
  /at least one entry/);
  await assert.rejects(checkPublicReadiness(async (url) =>
    url.endsWith('/api/health') ? response(sampleHealth) : response({
      ...sampleSites, sites: [{ name: 'Unreviewed', url: 'https://outside.invalid/' }]
    })), /unreviewed site URL/);
  await assert.rejects(checkPublicReadiness(async (url) =>
    url.endsWith('/api/health') ? response(sampleHealth) : response({
      ...sampleSites, sites: [{ ...sampleSites.sites[0], name: 'Impersonated name' }]
    })), /reviewed site identity/);
  await assert.rejects(checkPublicReadiness(async (url) =>
    url.endsWith('/api/health') ? response(sampleHealth) : response({
      ...sampleSites, sites: [...sampleSites.sites, sampleSites.sites[0]]
    })), /reviewed site count/);
  await assert.rejects(checkPublicReadiness(async () => { throw new Error('unreachable'); }), /unreachable/);
  await assert.rejects(checkPublicReadiness(healthy, 'http://127.0.0.1:8090/'),
    /reviewed public TV origin/);
  await assert.rejects(checkPublicReadiness(healthy,
    'https://zbrowse-tv.lizellay.chatgpt.site/?token=secret'), /reviewed public TV origin/);

  await testRealLoopbackCancellation();
  console.log('zBrowse public-origin read-only readiness contract passed');
}

function readOnlyMode(argv) {
  if (argv.length !== 1 || !['--self-test', '--live'].includes(argv[0])) {
    throw new Error('Exactly one readiness mode is required: --self-test or --live');
  }
  return argv[0];
}

// Self-tests must not be allowed to stand in for a requested live probe.
// Negative CLI probes are subprocesses with only invalid arguments: never
// invoke a live public endpoint when proving the fail-closed mode contract.
if (process.argv[2] === '--self-test' && process.argv.length === 3) {
  for (const bad of [
    [], ['--self-tset'], ['--live', '--self-test'], ['--self-test', '--live'],
    ['--self-test', '--self-test'], ['--live', '--live'],
    ['--self-test=true'], ['--self-test', '--unknown']
  ]) {
    assert.throws(() => readOnlyMode(bad), /Exactly one readiness mode/,
      'invalid readiness arguments must not select an ordinary green path');
    const child = spawnSync(process.execPath, [process.argv[1], ...bad], {
      encoding: 'utf8', timeout: 5000
    });
    assert.equal(child.status, 1, 'actual CLI must reject invalid readiness flags');
    assert.match(child.stderr, /Exactly one readiness mode/,
      'invalid real CLI must fail before a network probe');
    assert.doesNotMatch(child.stdout, /connected|Read-only proof/,
      'an invalid CLI must not print any successful live readiness result');
  }
}

const mode = readOnlyMode(process.argv.slice(2));
if (mode === '--self-test') {
  await selfTest();
} else {
  const health = await checkPublicReadiness();
  console.log('zBrowse public origin: ' + (health.available ? 'connected / capacity available' : 'connected / capacity busy'));
  console.log('Read-only proof: sites=' + health.siteCount + ', capacity=' + health.capacity +
    ', active=' + health.activeSessions + ', starting=' + health.startingSessions +
    ', maxMinutes=' + health.maxSessionMinutes);
}
