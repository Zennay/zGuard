// HTTP-level acceptance of the *shipped* authenticated viewer middleware.
// A synthetic upstream returns deliberately publicly cacheable content.
// No real gateway, browser container, session bearer, or external network.
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
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'gateway viewer route must remain extractable');
  return source.slice(start, end);
}

const app = express();
const token = 'V'.repeat(32); // synthetic, never issued by a browser gateway
const peerIp = '127.0.0.1';
const session = {
  token, ip: peerIp, password: 'fixture-only',
  containerName: 'fixture-browser',
  expiresAt: Date.now() + 600_000, lastSeenAt: Date.now()
};
const sessions = new Map([[token, session]]);
let proxyRequests = 0;
const sandbox = {
  app, sessions, requestPath, requestIp, trustProxyHops: 0,
  config: { idleMs: 300_000 },
  isSessionExpired() { return false; },
  console: { error() { throw new Error('unexpected viewer proxy error'); } },
  createProxyServer() {
    return {
      async web(req, res, options) {
        proxyRequests++;
        assert.equal(options.target, 'https://fixture-browser:3001',
          'viewer proxy must target the authorized synthetic session');
        assert.equal(options.auth, 'viewer:fixture-only');
        // Deliberately model a hostile upstream's public caching headers.
        res.writeHead(200, {
          'Cache-Control': 'public, max-age=3600',
          'Content-Type': 'text/plain; charset=utf-8'
        });
        res.end('local viewer fixture');
      }
    };
  }
};
const realHandler = section('function findSession(req) {', 'app.get("/api/health"') +
  '\n' + section('app.use("/s/", (req, res, next) => {', 'app.use("/api",');
vm.runInNewContext(realHandler, sandbox, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});

const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, peerIp, () => resolve(listening));
  listening.once('error', reject);
});
try {
  async function getViewer(requestToken) {
    const response = await fetch('http://' + peerIp + ':' + server.address().port +
      '/s/' + requestToken + '/', { signal: AbortSignal.timeout(4000) });
    const text = await response.text();
    return {
      status: response.status,
      body: text,
      cache: response.headers.get('cache-control')
    };
  }
  const authorized = await getViewer(token);
  assert.equal(authorized.status, 200, 'actual HTTP request must reach authorized viewer');
  assert.equal(authorized.body, 'local viewer fixture');
  assert.equal(proxyRequests, 1, 'authorized response must use real gateway forwarding handler');
  const denied = await getViewer('C'.repeat(32));
  assert.equal(denied.status, 403, 'unknown browser token must be denied via actual HTTP');
  assert.equal(proxyRequests, 1, 'unauthorized request must not reach proxy');

  function hasPrivateCachePolicy(value) {
    const directives = String(value || '').toLowerCase()
      .split(',').map(part => part.trim());
    return directives.includes('no-store') && !directives.includes('public');
  }
  const authorizedSafe = hasPrivateCachePolicy(authorized.cache);
  // Even 403 is sent from a bearer-bearing /s/:token/ URL. Browser, proxy and
  // intermediary caches must not retain rejected-token responses either.
  const deniedSafe = hasPrivateCachePolicy(denied.cache);
  if (strict) {
    assert.equal(authorizedSafe, true,
      'real HTTP authenticated viewer must override public upstream cache policy with no-store (issue #284)');
    assert.equal(deniedSafe, true,
      'real HTTP rejected-token viewer response must explicitly prohibit caching (issue #284)');
    console.log('Authenticated real HTTP viewer cache privacy PASS');
  } else {
    console.log('Shipped viewer proxy handled localhost authorized 200 and denied 403; ' +
      'upstream-public-cache overridden=' + authorizedSafe +
      ', rejected-token-cache protected=' + deniedSafe +
      ' (strict proof requires --require-no-store; issue #284 remains open)');
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
