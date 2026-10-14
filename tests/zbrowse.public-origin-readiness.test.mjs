// Read-only production routing acceptance for issue #293.
// Never creates browser sessions, requests /s/ tokens, or exports session state.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

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
  }
  let data;
  try {
    data = await response.json();
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
  cacheControl = 'no-store') {
  return new Response(contentType.startsWith('application/json') ? JSON.stringify(value) : '<html>Offline</html>', {
    status,
    headers: {
      'content-type': contentType,
      ...(cacheControl === null ? {} : { 'cache-control': cacheControl })
    }
  });
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
