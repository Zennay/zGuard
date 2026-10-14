// Source-bound real HTTP acceptance: CDN/surrogate cache hints on bearer
// viewer responses must never bypass the ordinary Cache-Control no-store.
// Synthetic upstream, localhost-only Express; no Docker or real browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { requestPath } from '../zbrowse/gateway/request-path.js';
import { requireExactCachePrivacyFlag } from '../tools/cache-privacy-flags.mjs';

const strict = requireExactCachePrivacyFlag(process.argv.slice(2));
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
function section(begin, end) {
  const first = source.indexOf(begin);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'shipped proxy/authorization source must be extractable');
  return source.slice(first, last);
}
const app = express();
const peer = '127.0.0.1';
const token = 'S'.repeat(32); // synthetic only
const session = {
  token, ip: peer, password: 'local-password-fixture',
  containerName: 'local-browser-fixture', lastSeenAt: Date.now(),
  expiresAt: Date.now() + 600_000
};
const sessions = new Map([[token, session]]);
let forwarded = 0;
let proxyResponseHook;
const upstreamPolicy = {
  'Cache-Control': 'public, max-age=3600',
  'Surrogate-Control': 'public, max-age=86400',
  'CDN-Cache-Control': 'public, s-maxage=86400',
  'Cloudflare-CDN-Cache-Control': 'public, s-maxage=86400',
  Expires: 'Wed, 21 Oct 2037 07:28:00 GMT',
  'Content-Type': 'text/plain; charset=utf-8'
};
const sandbox = {
  app, sessions, requestIp, requestPath, trustProxyHops: 0,
  config: { idleMs: 300_000 },
  isSessionExpired() { return false; },
  console: { error() { throw new Error('unexpected fixture proxy failure'); } },
  createProxyServer() {
    return {
      on(event, handler) {
        assert.equal(event, 'proxyRes', 'real gateway must attach its upstream response hook');
        proxyResponseHook = handler;
      },
      async web(req, res, options) {
        forwarded++;
        assert.equal(req.zbrowseSession, session, 'viewer must be authenticated before proxying');
        assert.equal(options.target, 'https://local-browser-fixture:3001');
        assert.equal(options.auth, 'viewer:local-password-fixture');
        const upstream = { headers: { ...upstreamPolicy } };
        if (proxyResponseHook) proxyResponseHook(upstream, req, res);
        const code = req.url.includes('/redirect') ? 302 :
          req.headers.range ? 206 : 200;
        if (code === 302) upstream.headers.Location = '/s/' + token + '/login';
        if (code === 206) upstream.headers['Content-Range'] = 'bytes 0-5/12';
        res.writeHead(code, upstream.headers);
        res.end(code === 302 ? undefined : code === 206 ? 'secret' : 'secret-data!');
      }
    };
  }
};
const code = section('function findSession(req) {', 'app.get("/api/health"') +
  '\n' + section('app.use("/s/", (req, res, next) => {', 'app.use("/api",');
vm.runInNewContext(code, sandbox, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});

const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, peer, () => resolve(listening));
  listening.once('error', reject);
});
try {
  const endpoint = 'http://' + peer + ':' + server.address().port;
  const cases = [
    ['200', '/s/' + token + '/assets/video', {}],
    ['206', '/s/' + token + '/assets/video', { range: 'bytes=0-5' }],
    ['302', '/s/' + token + '/redirect', {}]
  ];
  let survivedPolicy = 0;
  for (const [label, path, headers] of cases) {
    const response = await fetch(endpoint + path, {
      headers, redirect: 'manual', signal: AbortSignal.timeout(4000)
    });
    assert.equal(response.status, Number(label), 'actual HTTP viewer status must match scenario');
    await response.arrayBuffer();
    const directives = (response.headers.get('cache-control') || '')
      .toLowerCase().split(',').map(s => s.trim());
    assert.ok(directives.includes('no-store') && !directives.includes('public'),
      'shipped gateway must preserve its existing no-store viewer guard');
    // Surrogate/CDN vendor headers can direct shared cache storage separately
    // from Cache-Control. Their presence must not enable positive TTLs.
    const forbidden = [
      'surrogate-control', 'cdn-cache-control', 'cloudflare-cdn-cache-control'
    ];
    const dangerous = forbidden.some(name => {
      const policy = response.headers.get(name);
      return policy && !policy.toLowerCase().split(',').map(s => s.trim())
        .includes('no-store');
    }) || (response.headers.get('expires') &&
      Date.parse(response.headers.get('expires')) > Date.now());
    if (dangerous) survivedPolicy++;
  }
  const denied = await fetch(endpoint + '/s/' + 'U'.repeat(32) + '/assets/video', {
    redirect: 'manual', signal: AbortSignal.timeout(4000)
  });
  assert.equal(denied.status, 403, 'unknown bearer must be rejected before proxy');
  assert.equal(forwarded, cases.length, 'unknown bearer may not reach synthetic upstream');
  assert.ok((denied.headers.get('cache-control') || '').toLowerCase().includes('no-store'),
    'rejected bearer response must remain non-cacheable');
  await denied.arrayBuffer();

  if (strict) {
    assert.equal(survivedPolicy, 0,
      'CDN/Surrogate-Control or future Expires may still cache token-bearing viewer responses (issue #284)');
    console.log('Real HTTP viewer CDN/surrogate cache privacy PASS');
  } else {
    console.log('Real HTTP viewer CDN cache directives across 200/206/302: ' +
      'unexpected public-cache hints=' + survivedPolicy + '/' + cases.length +
      '. Strict CDN cache proof requires --require-no-store; issue #284 open');
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
