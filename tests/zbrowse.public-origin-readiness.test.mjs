// Read-only production routing acceptance for issue #293.
// Never creates browser sessions, requests /s/ tokens, or exports session state.
import assert from 'node:assert/strict';

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
    cache: 'no-store',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(7000)
  });
  assert.equal(response.ok, true, route + ': API must return 2xx, got HTTP ' + response.status);
  assert.match(
    response.headers.get('content-type') || '',
    /^application\/json(?:\s*;|$)/i,
    route + ': API must return JSON, not a static-site HTML fallback'
  );
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
  sites: [{ name: 'Reviewed', url: 'https://reviewed.example/watch' }],
  maxSessionMinutes: 15
};

function response(value, status = 200, contentType = 'application/json; charset=utf-8') {
  return new Response(contentType.startsWith('application/json') ? JSON.stringify(value) : '<html>Offline</html>', {
    status,
    headers: { 'content-type': contentType }
  });
}

async function selfTest() {
  const requested = [];
  const healthy = async (url, options) => {
    requested.push({ url, method: options.method, redirect: options.redirect });
    if (url.endsWith('/api/health')) return response(sampleHealth);
    if (url.endsWith('/api/sites')) return response(sampleSites);
    throw new Error('unexpected endpoint');
  };
  const normal = await checkPublicReadiness(healthy);
  assert.equal(normal.connected, true);
  assert.equal(normal.available, true);
  assert.equal(normal.siteCount, 1);
  assert.deepEqual(requested.map(({ url }) => new URL(url).pathname), ['/api/health', '/api/sites']);
  assert.ok(requested.every(({ method, redirect }) => method === 'GET' && redirect === 'error'),
    'readiness must be read-only and reject redirects');

  const busy = await checkPublicReadiness(async (url) =>
    url.endsWith('/api/health')
      ? response({ ...sampleHealth, activeSessions: 1 })
      : response(sampleSites));
  assert.equal(busy.connected, true, 'busy is not offline');
  assert.equal(busy.available, false, 'full capacity must be reported as busy');

  await assert.rejects(checkPublicReadiness(async () => response({}, 503)), /HTTP 503/);
  await assert.rejects(checkPublicReadiness(async () =>
    response({}, 200, 'text/html')), /static-site HTML fallback/);
  await assert.rejects(checkPublicReadiness(async (url) =>
    url.endsWith('/api/health') ? response({ ...sampleHealth, capacity: '1' }) : response(sampleSites)),
  /capacity must be an integer/);
  await assert.rejects(checkPublicReadiness(async (url) =>
    url.endsWith('/api/health') ? response(sampleHealth) : response({ ...sampleSites, maxSessionMinutes: undefined })),
  /maxSessionMinutes must be an integer/);
  await assert.rejects(checkPublicReadiness(async (url) =>
    url.endsWith('/api/health') ? response(sampleHealth) : response({ ...sampleSites, sites: [] })),
  /at least one entry/);
  await assert.rejects(checkPublicReadiness(async () => { throw new Error('unreachable'); }), /unreachable/);
  await assert.rejects(checkPublicReadiness(healthy, 'http://127.0.0.1:8090/'),
    /reviewed public TV origin/);
  await assert.rejects(checkPublicReadiness(healthy,
    'https://zbrowse-tv.lizellay.chatgpt.site/?token=secret'), /reviewed public TV origin/);

  console.log('zBrowse public-origin read-only readiness contract passed');
}

if (process.argv.includes('--self-test')) {
  await selfTest();
} else if (process.argv.includes('--live')) {
  const health = await checkPublicReadiness();
  console.log('zBrowse public origin: ' + (health.available ? 'connected / capacity available' : 'connected / capacity busy'));
  console.log('Read-only proof: sites=' + health.siteCount + ', capacity=' + health.capacity +
    ', active=' + health.activeSessions + ', starting=' + health.startingSessions +
    ', maxMinutes=' + health.maxSessionMinutes);
} else {
  throw new Error('Specify --self-test or --live; never allocate sessions during readiness');
}
