// Real loopback HTTP viewer proxy acceptance of the shipped gateway source.
// Browser/daemon/upstream are synthetic; no outbound network or production data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { requestPath } from '../zbrowse/gateway/request-path.js';
import { requireExactCachePrivacyFlag } from '../tools/cache-privacy-flags.mjs';

const strictNoStore = requireExactCachePrivacyFlag(process.argv.slice(2));

const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
function segment(begin, end) {
  const first = source.indexOf(begin);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'shipped viewer proxy source must be extractable');
  return source.slice(first, last);
}
const token = 'P'.repeat(32); // synthetic, never a live session credential
const ip = '127.0.0.1';
const session = {
  token, ip,
  containerName: 'approved-browser',
  password: 'upstream-test-only',
  expiresAt: Date.now() + 600_000,
  lastSeenAt: 0
};
const sessions = new Map([[token, session]]);
const app = express();
const forwarded = [];
const errors = [];
const sandbox = {
  app, sessions, requestPath, requestIp, trustProxyHops: 0,
  config: { idleMs: 300_000 },
  isSessionExpired() { return false; },
  console: { error(...args) { errors.push(args.map(String).join(' ')); } },
  createProxyServer() {
    return {
      async web(req, res, options) {
        assert.equal(req.zbrowseSession, session, 'upstream must get authorized session only');
        assert.equal(options.target, 'https://approved-browser:3001');
        assert.equal(options.auth, 'viewer:upstream-test-only',
          'gateway must derive Basic auth from stored browser, not request Authorization');
        assert.equal(options.secure, false, 'gateway fixture must preserve reviewed TLS handling');
        forwarded.push({ url: req.url, target: options.target, auth: options.auth });
        if (req.url.includes('/fail?')) throw new Error('synthetic upstream connection failure');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('forwarded:' + req.url);
      }
    };
  }
};
const code = [
  segment('function findSession(req) {', 'app.get("/api/health"'),
  segment('app.use("/s/", (req, res, next) => {', 'const browserProxy = createProxyServer();'),
  segment('const browserProxy = createProxyServer();', 'app.use("/api",')
].join('\n');
vm.runInNewContext(code, sandbox, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});
const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, ip, () => resolve(listening));
  listening.once('error', reject);
});
try {
  const target = 'http://' + ip + ':' + server.address().port;
  async function get(rawPath, headers = {}) {
    const response = await fetch(target + rawPath, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(4000)
    });
    return { status: response.status, body: await response.text(),
      cache: response.headers.get('cache-control') };
  }

  const assetPath = '/s/' + token + '/assets/player.js?v=1&lang=nl';
  const asset = await get(assetPath, { Authorization: 'Basic injected-client-secret' });
  assert.equal(asset.status, 200);
  assert.equal(asset.body, 'forwarded:' + assetPath,
    'real Express mount must not strip token prefix or query from the proxy target');
  assert.equal(forwarded.length, 1);

  const asset2 = '/s/' + token + '/screen/subdir/style.css?x=one%2Ftwo&y=3';
  const nested = await get(asset2);
  assert.equal(nested.status, 200);
  assert.equal(nested.body, 'forwarded:' + asset2,
    'nested paths and encoded query must not be rewritten or dropped');

  const rejected = await get('/s/' + 'U'.repeat(32) + '/assets/player.js');
  assert.equal(rejected.status, 403, 'unrecognized browser token must never proxy');
  assert.equal(forwarded.length, 2, 'invalid bearer must not reach container');

  session.ip = '192.0.2.75';
  const forged = await get(assetPath, { 'X-Forwarded-For': '192.0.2.75' });
  assert.equal(forged.status, 403,
    'forged forwarding header must not bypass TCP ownership on a real HTTP request');
  assert.equal(forwarded.length, 2, 'cross-owner browser assets must not be proxied');
  session.ip = ip;

  const failure = await get('/s/' + token + '/fail?reason=unreachable');
  assert.equal(failure.status, 502, 'proxy failure must yield a bounded HTTP gateway error');
  assert.equal(failure.body, 'Browser connection interrupted.',
    'error must not leak upstream password, host, token or exception details');
  assert.doesNotMatch(failure.body, /upstream-test-only|approved-browser|synthetic/);
  assert.equal(errors.length, 1, 'upstream failure should be diagnosed without HTTP detail leak');
  // A bearer-bearing /s/:token/ URL must never leave a cacheable reconnect
  // error, even when the upstream failed before returning any response headers.
  const policy = String(failure.cache || '').toLowerCase()
    .split(',').map(value => value.trim());
  const failureNoStore = policy.includes('no-store') && !policy.includes('public');
  if (strictNoStore) {
    assert.equal(failureNoStore, true,
      'gateway 502 proxy error under a bearer URL must explicitly be no-store (issue #284)');
  }

  const recovered = await get(assetPath);
  assert.equal(recovered.status, 200, 'successful proxy request must recover after upstream failure');
  assert.equal(recovered.body, 'forwarded:' + assetPath);
  assert.equal(forwarded.length, 4, 'valid forwards should remain available after errors');
  console.log('Real HTTP viewer proxy path, owner, error and recovery acceptance passed; ' +
    'token-bearing upstream-502 cache policy no-store=' + failureNoStore +
    ' (strict requires --require-no-store)');
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
