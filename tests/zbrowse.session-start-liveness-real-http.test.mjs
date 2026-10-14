// Source-bound real TCP proof: zBrowse TV start cannot hang indefinitely
// before HTTP headers or while reading an incomplete successful JSON body.
// Tests use fake bearer only; no production gateway/VPS, Docker or browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../zbrowse/gateway/public/app.js', import.meta.url), 'utf8');
const from = app.indexOf('async function cancelQuietly(');
const to = app.indexOf('\nfunction setMessage(', from);
assert.ok(from >= 0 && to > from, 'test must run the actual shipped request code');
const token = 'J'.repeat(32);
const payload = {
  token, viewerUrl: '/s/' + token + '/',
  expiresAt: Date.now() + 600_000, maxMinutes: 15
};
const seen = [];
let scenario = 'ok';
let lastSocketClosed = null;
const server = http.createServer((req, res) => {
  assert.equal(req.url, '/api/session');
  assert.equal(req.method, 'POST');
  seen.push(scenario);
  if (scenario === 'no-headers') {
    req.socket.once('close', () => { lastSocketClosed = true; });
    return; // Receive browser POST but never send response headers.
  }
  if (scenario === 'incomplete-body') {
    res.once('close', () => { lastSocketClosed = true; });
    res.writeHead(201, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.write('{ "token": ');
    return; // HTTP 201 is NOT proof a complete bearer was delivered.
  }
  const code = scenario === 'reuse' ? 200 : 201;
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store'
  }).end(JSON.stringify(payload));
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const local = 'http://127.0.0.1:' + server.address().port;
const context = {
  TextDecoder, Uint8Array, URL, AbortSignal, setTimeout, clearTimeout,
  fetch: (path, options) => {
    assert.equal(path, '/api/session', 'fixture may only request synthetic session creation');
    assert.equal(options.redirect, 'error', 'TV must retain fail-closed redirect policy');
    return fetch(local + path, options);
  }
};
vm.runInNewContext(app.slice(from, to) + '\nglobalThis.testRequest = request;', context,
  { timeout: 1000, filename: 'zbrowse/gateway/public/app.js' });
const request = context.testRequest;
async function start(timeoutMs = 6000) {
  return request('/api/session', {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(timeoutMs)
  });
}
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  for (const mode of ['ok', 'reuse']) {
    scenario = mode;
    const result = await start();
    assert.equal(result.token, token, mode + ': valid response still works');
    assert.equal(result.viewerUrl, '/s/' + token + '/');
  }
  for (const mode of ['no-headers', 'incomplete-body']) {
    scenario = mode;
    lastSocketClosed = false;
    const before = seen.length;
    await assert.rejects(start(150), undefined,
      mode + ': failed TCP response cannot keep session-start waiting');
    assert.equal(seen.length, before + 1, mode + ': do not retry unknown starts');
    // undici/browser-like fetch sends abort to the actual HTTP socket;
    // allow a bounded grace interval for FIN/close event scheduling.
    for (let i = 0; i < 25 && !lastSocketClosed; i++) await tick(20);
    assert.equal(lastSocketClosed, true,
      mode + ': aborted real TCP response must close the transport');
  }
  scenario = 'ok';
  assert.equal((await start()).token, token,
    'a disconnected TCP start must not prevent later clean session starts');
  console.log('TV session start liveness passed: real localhost HTTP 201 success, ' +
    'HTTP 200 reuse, stalled headers, stalled streamed 201 and recovery');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
