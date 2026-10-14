// Real loopback HTTP proof of the shipped TV request() response budgets.
// Deliberately synthetic sessions: no public origin, bearer or Docker access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const source = fs.readFileSync(
  new URL('../zbrowse/gateway/public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function cancelQuietly(');
const end = source.indexOf('\nfunction setMessage(', start);
assert.ok(start !== -1 && end > start,
  'execute the actual shipped request()/stream parser, not a duplicate');
const requestCode = source.slice(start, end);
const token = 'X'.repeat(32);
let serve;
let activeResponse;
const hits = [];
const server = http.createServer((req, res) => {
  hits.push({ method: req.method, url: req.url });
  activeResponse = res;
  serve(req, res);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = 'http://127.0.0.1:' + server.address().port;
const browserFetch = (route, options) => {
  assert.match(route, /^\/api\/session(?:\/[A-Za-z0-9_-]{32}(?:\/heartbeat)?)?$/,
    'QA fetch must stay on synthetic session routes');
  return fetch(origin + route, { ...options, redirect: 'error' });
};
let fetchAdapter = browserFetch;
const context = {
  fetch: (route, options) => fetchAdapter(route, options),
  TextDecoder, Uint8Array, URL, AbortSignal,
  setTimeout, clearTimeout
};
vm.runInNewContext(requestCode + '\nglobalThis.testRequest = request;', context,
  { filename: 'zbrowse/gateway/public/app.js', timeout: 1500 });
const request = context.testRequest;
assert.equal(typeof request, 'function');

function send(res, status, payload, { encoding, type = 'application/json', chunked = false } = {}) {
  const plain = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const body = encoding === 'br' ? brotliCompressSync(plain) :
    encoding === 'gzip' ? gzipSync(plain) : plain;
  const headers = { 'content-type': type, 'cache-control': 'no-store' };
  if (encoding) headers['content-encoding'] = encoding;
  if (!chunked) headers['content-length'] = String(body.byteLength);
  res.writeHead(status, headers);
  res.end(body);
  return { wireBytes: body.byteLength, decodedBytes: plain.byteLength };
}

async function caseRun(label, responder, route, options, check) {
  serve = responder;
  const before = hits.length;
  await check(request(route, options));
  assert.equal(hits.length, before + 1, label + ': exactly one real HTTP request');
  assert.equal(hits.at(-1).url, route, label + ': correct gateway route');
  assert.equal(hits.at(-1).method, options.method, label + ': correct HTTP method');
}
const create = { method: 'POST', body: '{}' };
const heartbeat = { method: 'POST', body: '{}', signal: AbortSignal.timeout(7000) };
const deletion = { method: 'DELETE', signal: AbortSignal.timeout(7000) };
const routeDelete = '/api/session/' + token;
const routeHeartbeat = routeDelete + '/heartbeat';
const payload = {
  token, viewerUrl: '/s/' + token + '/',
  expiresAt: Date.now() + 600000, maxMinutes: 15
};

try {
  for (const status of [200, 201]) {
    await caseRun('normal browser start ' + status,
      (_req, res) => send(res, status, payload),
      '/api/session', create, async promise => {
        const result = await promise;
        assert.equal(result.token, token, 'normal start/reuse stays functional');
      });
  }
  await caseRun('normal heartbeat',
    (_req, res) => send(res, 200, { ok: true, expiresAt: payload.expiresAt }),
    routeHeartbeat, heartbeat, async promise => {
      assert.equal((await promise).ok, true);
    });
  await caseRun('normal release',
    (_req, res) => res.writeHead(204).end(),
    routeDelete, deletion, async promise => assert.equal(await promise, null));

  // Bytes returned by the browser fetch stream are *decompressed* bytes.
  // A small advertised wire Content-Length must never bypass the JSON cap.
  for (const algorithm of ['gzip', 'br']) {
    let sizes;
    await caseRun('compressed start expansion ' + algorithm,
      (_req, res) => {
        sizes = send(res, 201, { ...payload, padding: 'x'.repeat(12000) },
          { encoding: algorithm });
      }, '/api/session', create, async promise => {
        await assert.rejects(promise, /too large|size/i);
      });
    assert.ok(sizes.wireBytes < 4096 && sizes.decodedBytes > 4096,
      'fixture must demonstrate a compressed response inflation gap');
  }
  await caseRun('chunked successful start overflow',
    (_req, res) => send(res, 201, { ...payload, padding: 'x'.repeat(5000) },
      { chunked: true }),
    '/api/session', create, async promise => {
      await assert.rejects(promise, /too large|size/i);
    });
  await caseRun('declared oversized successful start',
    (_req, res) => send(res, 200, { ...payload, padding: 'x'.repeat(6000) }),
    '/api/session', create, async promise => {
      await assert.rejects(promise, /too large|size/i);
    });
  await caseRun('compressed heartbeat inflation',
    (_req, res) => send(res, 200,
      { ok: true, expiresAt: payload.expiresAt, padding: 'x'.repeat(3000) },
      { encoding: 'br' }),
    routeHeartbeat, heartbeat, async promise => {
      await assert.rejects(promise, /too large|size/i);
    });
  await caseRun('malformed start UTF-8',
    (_req, res) => send(res, 201, Buffer.from([0xc3, 0x28])),
    '/api/session', create, async promise => {
      await assert.rejects(promise);
    });

  // Only the exact, small, typed gateway 404/410 JSON contract can certify
  // that the browser is gone. Never trust raw proxy error text or statuses.
  for (const [status, error] of [[404, 'Session not found.'], [410, 'Session expired.']]) {
    await caseRun('documented gone ' + status,
      (_req, res) => send(res, status, { error }),
      routeDelete, deletion, async promise => {
        await assert.rejects(promise, reason => {
          assert.equal(reason.status, status);
          assert.equal(reason.confirmedSessionGone, true);
          return true;
        });
      });
  }
  for (const [status, body, type] of [
    [404, { error: 'Session not found.', padding: 'x'.repeat(10000) }, 'application/json'],
    [410, { error: 'Session expired.' }, 'text/html'],
    [404, { error: 'Unexpected proxy error' }, 'application/json'],
    [502, { error: 'Session not found.', padding: 'x'.repeat(100000) }, 'application/json'],
    [503, { error: 'Session expired.' }, 'application/json']
  ]) {
    await caseRun('not-confirmed release ' + status,
      (_req, res) => send(res, status, body, { type }),
      routeDelete, deletion, async promise => {
        await assert.rejects(promise, reason => {
          assert.notEqual(reason.confirmedSessionGone, true,
            'unreviewed DELETE reply must retain browser capacity');
          return true;
        });
      });
  }
  await caseRun('proxy 200 must not confirm release',
    (_req, res) => send(res, 200, { ok: true }),
    routeDelete, deletion, async promise => {
      await assert.rejects(promise, /Unexpected session release status/);
    });

  // A stalled stream after HTTP headers must use the same abort signal as
  // the initial fetch. Closing the connection releases the local fixture.
  await caseRun('heartbeat body stops on abort',
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); },
    routeHeartbeat,
    { method: 'POST', body: '{}', signal: AbortSignal.timeout(100) },
    async promise => {
      await assert.rejects(promise);
    });

  // Some stream adapters never acknowledge cancel(). The TV must still
  // settle rejected responses instead of hanging its offline/end-session UI.
  for (const [route, method, status] of [
    ['/api/health', 'GET', 503],
    ['/api/sites', 'GET', 502],
    ['/api/session', 'POST', 500],
    [routeHeartbeat, 'POST', 503],
    [routeHeartbeat, 'POST', 202],
    ['/api/health', 'GET', 206]
  ]) {
    let cancels = 0;
    let parsed = 0;
    fetchAdapter = async () => ({
      status, ok: status >= 200 && status < 300,
      headers: { get: () => 'application/json' },
      body: { cancel: () => { cancels++; return new Promise(() => {}); } },
      json: () => { parsed++; throw Error('must not parse proxy diagnostic'); }
    });
    let watchdog;
    try {
      const settled = Promise.race([
        request(route, { method }),
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('cancel() stalled TV response')), 1000);
        })
      ]);
      await assert.rejects(settled, error => {
        assert.notEqual(error.message, 'cancel() stalled TV response',
          'gateway error handler must not wait forever for cancel()');
        return true;
      });
    } finally {
      clearTimeout(watchdog);
    }
    assert.equal(cancels, 1, route + ' ' + status + ': exactly one bounded cancel');
    assert.equal(parsed, 0, route + ' ' + status + ': no unreviewed proxy parsing');
  }
  fetchAdapter = browserFetch;

  console.log('Session JSON response budgets passed: real loopback gzip/Brotli, ' +
    'chunked overflow, strict teardown 404/410, stalled heartbeat abort, ' +
    'and bounded cancellation of rejected responses');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
