// Real Express 502 path, actual shipped proxy error logger, loopback only.
// Error text is a synthetic upstream test double, NOT proof a production
// upstream has emitted those strings. No real credential, VPS or Docker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { format } from 'node:util';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { requestPath } from '../zbrowse/gateway/request-path.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-redacted-proxy-errors');
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
function segment(begin, end) {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start);
  assert.ok(start >= 0 && stop > start,
    'gateway authenticated viewer and error logger must be extractable');
  return source.slice(start, stop);
}

const app = express();
const ip = '127.0.0.1';
const token = 'L'.repeat(32); // synthetic, never a production bearer
const password = 'qa-upstream-password-fixture';
const basicAuth = Buffer.from('viewer:' + password).toString('base64');
const session = {
  token, ip, password, containerName: 'fixture-browser',
  lastSeenAt: Date.now(), expiresAt: Date.now() + 600_000
};
const sessions = new Map([[token, session]]);
const captured = [];
const errors = [
  new Error('proxy failure on /s/' + token +
    '/websockify Authorization: Basic ' + basicAuth),
  new Error('upstream URL https://sample-user:sample-pass@example.invalid/' +
    '?viewerToken=' + token + ' password=' + password),
  // A proxy exception can also carry arbitrary line breaks; a diagnostic
  // must never let untrusted text forge additional log records.
  new Error('synthetic proxy failure\n[INFO] fake-success /s/' + token),
  // Terminal control sequences and Unicode line separators can falsify
  // viewer diagnostics even without literal CR or LF in the error message.
  new Error('synthetic proxy failure\u001b[2J\u001b[H[OK] forged healthy session\u2028' +
    'PASSWORD=' + password)
];
// A future logging refactor must never print Error objects wholesale: Node
// util.format recursively renders nested causes and enumerable request data.
const nestedFailure = new Error('synthetic proxy upstream disconnected');
nestedFailure.cause = new Error('Authorization: Bearer ' + token);
nestedFailure.code = 'secret-' + token;
nestedFailure.request = {
  url: 'https://sample-user:sample-pass@example.invalid/s/' + token,
  headers: { authorization: 'Basic ' + basicAuth },
  env: { PASSWORD: password }
};
assert.ok(format('Browser proxy error', nestedFailure).includes(token),
  'negative control: native Node Error formatting exposes nested bearer data');
errors.push(nestedFailure);
// Confirm a reviewed network failure remains diagnosable, while arbitrary
// external error codes cannot smuggle an otherwise secret bearer into logs.
errors[0].code = 'ECONNRESET';
errors[1].code = token;
let forwards = 0;
const sandbox = {
  app, sessions, requestIp, requestPath, trustProxyHops: 0,
  config: { idleMs: 300_000 },
  isSessionExpired() { return false; },
  console: { error(...args) { captured.push(format(...args)); } },
  createProxyServer() {
    return {
      async web(req, res, options) {
        forwards++;
        assert.equal(req.zbrowseSession, session,
          'only authenticated viewer requests may trigger upstream errors');
        assert.equal(options.auth, 'viewer:' + password,
          'credentials must be gateway-generated, not user forwarded');
        const error = errors.shift();
        if (req.url.includes('/partial/')) {
          // Exercise the OTHER shipped browserProxyError() branch: once the
          // upstream sends bytes, a 502 cannot replace the partial response.
          assert.equal(error, undefined, 'streamed case runs after initial failures');
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write('public fixture data only');
          assert.equal(res.headersSent, true,
            'partial upstream response must already have started');
          throw new Error('streamed proxy error /s/' + token +
            ' Authorization: Bearer ' + token + '\r\nPassword=' + password);
        }
        if (error) throw error;
        res.writeHead(200, { 'content-type': 'text/plain' }).end('recovered');
      }
    };
  }
};
const handler = [
  segment('function findSession(req) {', 'app.get("/api/health"'),
  segment('app.use("/s/", (req, res, next) => {', 'app.use("/api",')
].join('\n');
assert.ok(handler.includes('function browserProxyError('),
  'source-bound HTTP fixture must execute shipped proxy error logger');
vm.runInNewContext(handler, sandbox, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});

const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, ip, () => resolve(listening));
  listening.once('error', reject);
});
try {
  const endpoint = 'http://' + ip + ':' + server.address().port;
  async function get(url) {
    const reply = await fetch(endpoint + url, {
      redirect: 'error', signal: AbortSignal.timeout(4000)
    });
    return { status: reply.status, body: await reply.text() };
  }
  const viewer = '/s/' + token + '/assets/player.js?quality=1';
  const first = await get(viewer);
  const second = await get(viewer);
  const third = await get(viewer);
  const fourth = await get(viewer);
  const fifth = await get(viewer);
  for (const response of [first, second, third, fourth, fifth]) {
    assert.equal(response.status, 502,
      'real gateway must report synthetic upstream connection failure');
    assert.equal(response.body, 'Browser connection interrupted.',
      'the public 502 error must remain generic and credential-free');
  }
  assert.equal(captured.length, 5, 'every upstream failure should record a diagnostic');
  assert.ok(captured.every(line => line.includes('Browser proxy error')),
    'logging must keep a generic upstream failure signal');

  const denied = await get('/s/' + 'U'.repeat(32) + '/assets/player.js');
  assert.equal(denied.status, 403,
    'invalid token must be blocked before any upstream error path');
  assert.equal(forwards, 5, 'denied tokens must never be forwarded upstream');

  const restored = await get(viewer);
  assert.deepEqual(restored, { status: 200, body: 'recovered' },
    'a connection failure must not disable later authorized browser use');
  assert.equal(forwards, 6);

  // A streaming proxy can fail AFTER its first bytes have reached the HTTP
  // client. The handler must close the already-committed response, not try
  // to append a 502 or leak arbitrary upstream error text to its logs.
  await assert.rejects(
    get('/s/' + token + '/partial/stream'),
    'a partially written, interrupted gateway stream must terminate abruptly'
  );
  assert.equal(forwards, 7, 'only the authorized streamed request reached proxy');
  assert.equal(captured.length, 6,
    'the partially sent response must also record a proxy failure diagnostic');

  // Deliberately inspect only in memory. Do not include any synthetic bearer
  // or credential text in CI diagnostics; the pass/fail count is sufficient.
  const sensitiveCanaries = [token, password, basicAuth,
    'sample-user', 'sample-pass', 'viewerToken='];
  // Model the rejected unsafe logger with real util.format, not String(error)
  // which hides the exact nested credentials that Node console would expose.
  const unsafeObjectLog = format('Browser proxy error', nestedFailure);
  assert.ok(sensitiveCanaries.some(needle => unsafeObjectLog.includes(needle)),
    'negative control: serializing a nested proxy Error must fail log privacy');
  const leaking = captured.filter(line =>
    sensitiveCanaries.some(needle => line.includes(needle)) ||
    /[\r\n\x1b\u2028\u2029]/.test(line));
  if (strict) {
    assert.equal(leaking.length, 0,
      'viewer proxy diagnostics must redact bearer paths, credentials and injected log lines');
    assert.equal(captured[0], 'Browser proxy error ECONNRESET',
      'known allowlisted network codes must remain actionable');
    assert.ok(captured.slice(1).every(line => line === 'Browser proxy error UPSTREAM_FAILURE'),
      'arbitrary codes and untrusted error messages must collapse to a bounded category');
  }
  console.log('Shipped viewer proxy error logging over localhost (including ' +
    'one interrupted response after headers): ' +
    captured.length + ' synthetic upstream failures; privacy-safe logs=' +
    (captured.length - leaking.length) + '/' + captured.length +
    '; strict remediation proof: --require-redacted-proxy-errors');
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
