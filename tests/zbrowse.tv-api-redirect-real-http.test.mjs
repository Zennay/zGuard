// Actual 127.0.0.1 HTTP redirect isolation of the shipped TV API client.
// No VPS, public website, production bearer or remote browser is contacted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../zbrowse/gateway/public/app.js', import.meta.url), 'utf8');
const first = app.indexOf('async function cancelQuietly(');
const last = app.indexOf('\nfunction setMessage(', first);
assert.ok(first > 0 && last > first, 'execute shipped TV request code, not a duplicate');
const shipped = app.slice(first, last);
const deny = 'redirect: "error"';
assert.ok(shipped.includes(deny), 'the TV fetch must enforce redirect rejection');
const token = 'Q'.repeat(32);
const owned = '/api/session/' + token;
const urls = [
  ['/api/health', 'GET'],
  ['/api/sites', 'GET'],
  ['/api/session', 'POST'],
  [owned + '/heartbeat', 'POST'],
  [owned, 'DELETE']
];
const seen = [];
let mode = 'normal';
let redirectStatus = 307;
const statusBody = {
  status: 'ok', activeSessions: 0, startingSessions: 0, capacity: 1
};
const successResponse = (res, path) => {
  if (path === owned) {
    res.writeHead(204).end();
    return;
  }
  const body = path === '/api/health' ? statusBody :
    path === '/api/sites' ? {
      sites: [{ name: 'Approved', url: 'https://approved.invalid/' }],
      maxSessionMinutes: 15
    } : path.endsWith('/heartbeat') ? {
      ok: true, expiresAt: Date.now() + 600000
    } : {
      token, viewerUrl: '/s/' + token + '/',
      maxMinutes: 15, expiresAt: Date.now() + 600000
    };
  res.writeHead(path === '/api/session' ? 201 : 200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  }).end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  seen.push({ path: req.url, method: req.method });
  if (req.url === '/redirect-target') {
    successResponse(res, '/api/session');
    return;
  }
  if (mode === 'redirect') {
    res.writeHead(redirectStatus, {
      location: '/redirect-target',
      'cache-control': 'no-store'
    }).end();
    return;
  }
  successResponse(res, req.url);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = 'http://127.0.0.1:' + server.address().port;

function compile(source) {
  const context = {
    fetch: (path, options) => {
      assert.ok(urls.some(([reviewed]) => reviewed === path),
        'TV API must never construct an unreviewed gateway path');
      return fetch(origin + path, options);
    },
    TextDecoder, Uint8Array, URL, AbortSignal, setTimeout, clearTimeout
  };
  vm.runInNewContext(source + '\nglobalThis.testRequest = request;', context,
    { timeout: 1000, filename: 'zbrowse/gateway/public/app.js' });
  return context.testRequest;
}
const request = compile(shipped);
const opts = (method) => ({
  method, ...(method === 'POST' ? { body: '{}' } : {}),
  signal: AbortSignal.timeout(7000)
});

try {
  for (const [path, method] of urls) {
    mode = 'normal';
    const response = await request(path, opts(method));
    if (path === owned) assert.equal(response, null, 'documented DELETE 204 works');
    else assert.equal(typeof response, 'object', 'valid API response still works');
    assert.equal(seen.at(-1).path, path, 'normal API must remain on reviewed route');
  }

  let checked = 0;
  for (const status of [301, 302, 303, 307, 308]) {
    for (const [path, method] of urls) {
      mode = 'redirect';
      redirectStatus = status;
      const before = seen.length;
      await assert.rejects(request(path, opts(method)), undefined,
        path + ': redirect ' + status + ' must fail closed');
      assert.equal(seen.length, before + 1,
        path + ': redirect must NOT issue a second request');
      assert.deepEqual(seen.slice(before), [{ path, method }],
        path + ': redirect must not rewrite method or path');
      checked++;
    }
  }

  // An intentionally weakened copy proves the test catches redirect replay.
  // The 307 keeps POST and DELETE methods, making silent fetch-follow unsafe.
  const mutated = shipped.replace(deny, 'redirect: "follow"');
  assert.notEqual(mutated, shipped, 'mutation must change actual fetch setting');
  const unsafeRequest = compile(mutated);
  mode = 'redirect';
  redirectStatus = 307;
  const before = seen.length;
  const reply = await unsafeRequest('/api/session', opts('POST'));
  assert.equal(reply.token, token,
    'negative control: following a 307 accepts synthetic wrong-route bearer');
  assert.deepEqual(seen.slice(before), [
    { path: '/api/session', method: 'POST' },
    { path: '/redirect-target', method: 'POST' }
  ], 'negative mutation must demonstrate redirect replay over real HTTP');

  console.log('TV API redirect isolation passed: ' + checked +
    ' real HTTP fail-closed status/method cases, valid success controls ' +
    'and an actual 307 replay mutation');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
