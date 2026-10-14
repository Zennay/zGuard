// Real Express 502 path, actual shipped proxy error logger, loopback only.
// Error text is a synthetic upstream test double, NOT proof a production
// upstream has emitted those strings. No real credential, VPS or Docker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
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
    '?viewerToken=' + token + ' password=' + password)
];
let forwards = 0;
const sandbox = {
  app, sessions, requestIp, requestPath, trustProxyHops: 0,
  config: { idleMs: 300_000 },
  isSessionExpired() { return false; },
  console: { error(...args) { captured.push(args.map(String).join(' ')); } },
  createProxyServer() {
    return {
      async web(req, res, options) {
        forwards++;
        assert.equal(req.zbrowseSession, session,
          'only authenticated viewer requests may trigger upstream errors');
        assert.equal(options.auth, 'viewer:' + password,
          'credentials must be gateway-generated, not user forwarded');
        const error = errors.shift();
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
  for (const response of [first, second]) {
    assert.equal(response.status, 502,
      'real gateway must report synthetic upstream connection failure');
    assert.equal(response.body, 'Browser connection interrupted.',
      'the public 502 error must remain generic and credential-free');
  }
  assert.equal(captured.length, 2, 'every upstream failure should record a diagnostic');
  assert.ok(captured.every(line => line.includes('Browser proxy error')),
    'logging must keep a generic upstream failure signal');

  const denied = await get('/s/' + 'U'.repeat(32) + '/assets/player.js');
  assert.equal(denied.status, 403,
    'invalid token must be blocked before any upstream error path');
  assert.equal(forwards, 2, 'denied tokens must never be forwarded upstream');

  const restored = await get(viewer);
  assert.deepEqual(restored, { status: 200, body: 'recovered' },
    'a connection failure must not disable later authorized browser use');
  assert.equal(forwards, 3);

  // Deliberately inspect only in memory. Do not include any synthetic bearer
  // or credential text in CI diagnostics; the pass/fail count is sufficient.
  const sensitiveCanaries = [token, password, basicAuth,
    'sample-user', 'sample-pass', 'viewerToken='];
  const leaking = captured.filter(line =>
    sensitiveCanaries.some(needle => line.includes(needle)));
  if (strict) {
    assert.equal(leaking.length, 0,
      'viewer proxy diagnostics must redact bearer paths, Basic auth and URL userinfo (new QA owner handoff)');
  }
  console.log('Shipped viewer proxy error logging over localhost: ' +
    captured.length + ' synthetic upstream failures; privacy-safe logs=' +
    (captured.length - leaking.length) + '/' + captured.length +
    '; strict remediation proof: --require-redacted-proxy-errors');
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
