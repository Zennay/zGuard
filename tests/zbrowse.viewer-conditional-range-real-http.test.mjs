// Source-bound real loopback Express acceptance for token-bearing viewer URLs.
// Range/conditional/HEAD responses can be cached by browsers and intermediaries.
// Only synthetic sessions/upstream data are used; no Docker, VPS or public URL.
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
function segment(startMarker, endMarker) {
  const a = source.indexOf(startMarker);
  const b = source.indexOf(endMarker, a);
  assert.ok(a >= 0 && b > a, 'shipped gateway viewer handler must remain extractable');
  return source.slice(a, b);
}
const app = express();
const peer = '127.0.0.1';
const token = 'R'.repeat(32); // local synthetic token, never a real bearer
const session = {
  token, ip: peer, password: 'fixture-only',
  containerName: 'fixture-browser', lastSeenAt: Date.now(),
  expiresAt: Date.now() + 600_000
};
const sessions = new Map([[token, session]]);
const forwarded = [];
let errors = 0;
const sandbox = {
  app, sessions, requestIp, requestPath, trustProxyHops: 0,
  config: { idleMs: 300_000 },
  isSessionExpired() { return false; },
  console: { error() { errors++; } },
  createProxyServer() {
    return {
      async web(req, res, options) {
        assert.equal(req.zbrowseSession, session,
          'only authenticated session should reach browser proxy');
        assert.equal(options.target, 'https://fixture-browser:3001');
        assert.equal(options.auth, 'viewer:fixture-only',
          'upstream authentication must be derived from stored session');
        assert.equal(req.headers.authorization, undefined,
          'fixture must not trust a client Authorization header');
        forwarded.push({ method: req.method, url: req.url,
          range: req.headers.range, validator: req.headers['if-none-match'],
          modifiedSince: req.headers['if-modified-since'],
          ifRange: req.headers['if-range'] });
        const headers = {
          'Cache-Control': 'public, max-age=3600',
          'ETag': '"synthetic-viewer-resource"',
          'Last-Modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
          'Content-Type': 'text/plain; charset=utf-8'
        };
        if (req.url.includes('/broken')) {
          throw new Error('synthetic failed upstream');
        }
        if (req.url.includes('/login-redirect')) {
          res.writeHead(302, {
            ...headers, Location: '/s/' + token + '/login'
          }).end();
        } else if (req.url.includes('/auth-required')) {
          res.writeHead(401, {
            ...headers, 'WWW-Authenticate': 'Basic realm="synthetic-viewer"'
          }).end('authorization required');
        } else if (req.url.includes('/upstream-error')) {
          res.writeHead(500, headers).end('synthetic upstream 500');
        } else if (req.headers['if-none-match'] === '"synthetic-viewer-resource"' ||
          req.headers['if-modified-since'] === 'Wed, 21 Oct 2015 07:28:00 GMT') {
          res.writeHead(304, headers).end();
        } else if (req.headers.range === 'bytes=0-5') {
          res.writeHead(206, { ...headers, 'Content-Range': 'bytes 0-5/12' })
            .end('secret');
        } else if (req.headers.range === 'bytes=500-600') {
          res.writeHead(416, { ...headers, 'Content-Range': 'bytes */12' }).end();
        } else {
          res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : 'secret-data!');
        }
      }
    };
  }
};
const code = [
  segment('function findSession(req) {', 'app.get("/api/health"'),
  segment('app.use("/s/", (req, res, next) => {', 'app.use("/api",')
].join('\n');
vm.runInNewContext(code, sandbox, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});

const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, peer, () => resolve(listening));
  listening.once('error', reject);
});
try {
  const endpoint = 'http://' + peer + ':' + server.address().port;
  async function request(label, method, url, headers = {}) {
    const res = await fetch(endpoint + url, {
      method, headers, redirect: 'manual', signal: AbortSignal.timeout(4000)
    });
    return {
      label, status: res.status, method, text: await res.text(),
      cache: res.headers.get('cache-control'),
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      range: res.headers.get('content-range'),
      location: res.headers.get('location'),
      challenge: res.headers.get('www-authenticate')
    };
  }
  const base = '/s/' + token + '/assets/screen.txt?quality=1';
  const cases = [];
  const normal = await request('normal GET 200', 'GET', base);
  cases.push(normal);
  assert.equal(normal.status, 200);
  assert.equal(normal.text, 'secret-data!');
  assert.equal(normal.etag, '"synthetic-viewer-resource"',
    'synthetic upstream validator must be observable');

  const partial = await request('range GET 206', 'GET', base, {
    range: 'bytes=0-5'
  });
  cases.push(partial);
  assert.equal(partial.status, 206, 'HTTP Range should preserve upstream partial status');
  assert.equal(partial.text, 'secret', 'real proxy fixture returns six partial bytes');
  assert.equal(partial.range, 'bytes 0-5/12');

  const notModified = await request('conditional GET 304', 'GET', base, {
    'if-none-match': normal.etag
  });
  cases.push(notModified);
  assert.equal(notModified.status, 304,
    'conditional viewer asset may return a bodyless 304');
  assert.equal(notModified.text, '', '304 must never contain a body');

  // Besides ETag-based 304 and Range 206, browsers can revalidate with
  // If-Modified-Since, or resume a bearer asset via If-Range. Treat each
  // conditional result as token-bearing content for strict no-store.
  const modified = await request('If-Modified-Since GET 304', 'GET', base, {
    'if-modified-since': normal.lastModified
  });
  cases.push(modified);
  assert.equal(modified.status, 304,
    'unchanged Last-Modified validator must generate a bodyless 304');
  assert.equal(modified.text, '', 'time-conditional 304 must not carry a body');

  const ifRange = await request('If-Range partial GET 206', 'GET', base, {
    range: 'bytes=0-5', 'if-range': normal.etag
  });
  cases.push(ifRange);
  assert.equal(ifRange.status, 206,
    'If-Range session resume should preserve partial content status');
  assert.equal(ifRange.text, 'secret',
    'resumed bearer download must contain only the requested partial bytes');

  const partialHead = await request('partial HEAD 206', 'HEAD', base, {
    range: 'bytes=0-5'
  });
  cases.push(partialHead);
  assert.equal(partialHead.status, 206,
    'HEAD partial metadata should preserve upstream 206 status');
  assert.equal(partialHead.text, '', 'HEAD must not expose any asset body');
  assert.equal(partialHead.range, 'bytes 0-5/12');

  const head = await request('viewer HEAD 200', 'HEAD', base);
  cases.push(head);
  assert.equal(head.status, 200);
  assert.equal(head.text, '', 'HEAD must not return a viewer body');

  const conditionalHead = await request('conditional HEAD 304', 'HEAD', base, {
    'if-none-match': normal.etag
  });
  cases.push(conditionalHead);
  assert.equal(conditionalHead.status, 304);
  assert.equal(conditionalHead.text, '');

  const unsatisfiable = await request('invalid range 416', 'GET', base, {
    range: 'bytes=500-600'
  });
  cases.push(unsatisfiable);
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.range, 'bytes */12');

  // A bearer viewer's 302 Location, upstream authorization challenge and
  // server-error response must remain uncached too, not just successful
  // assets and conditional/range variants.
  const redirect = await request('viewer redirect 302', 'GET',
    '/s/' + token + '/login-redirect?continue=1');
  cases.push(redirect);
  assert.equal(redirect.status, 302,
    'manual redirect must not follow the bearer-scoped Location');
  assert.equal(new URL(redirect.location, endpoint).pathname,
    '/s/' + token + '/login',
    'synthetic redirect should preserve its bearer-scoped viewer target');

  const challenge = await request('upstream auth 401', 'GET',
    '/s/' + token + '/auth-required');
  cases.push(challenge);
  assert.equal(challenge.status, 401);
  assert.equal(challenge.challenge, 'Basic realm="synthetic-viewer"',
    'viewer auth challenge must pass through unchanged for real browser');

  const upstream500 = await request('upstream status 500', 'GET',
    '/s/' + token + '/upstream-error');
  cases.push(upstream500);
  assert.equal(upstream500.status, 500,
    'upstream 500 must not be misclassified as a proxy transport failure');

  const rejected = await request('unknown token 403', 'GET',
    '/s/' + 'U'.repeat(32) + '/assets/screen.txt');
  cases.push(rejected);
  assert.equal(rejected.status, 403, 'unknown bearer must not reach upstream');
  const deniedHead = await request('unknown token HEAD 403', 'HEAD',
    '/s/' + 'U'.repeat(32) + '/assets/screen.txt');
  cases.push(deniedHead);
  assert.equal(deniedHead.status, 403);
  assert.equal(deniedHead.text, '');

  const failed = await request('proxy failure 502', 'GET',
    '/s/' + token + '/broken?retry=1');
  cases.push(failed);
  assert.equal(failed.status, 502);
  assert.equal(failed.text, 'Browser connection interrupted.');
  assert.equal(errors, 1);
  assert.equal(forwarded.length, 13,
    'all twelve owner responses plus one transport failure must proxy, never denied tokens');
  assert.equal(forwarded[0].url, base,
    'viewer proxy must preserve original bearer path/query');

  const cacheSafe = (cache) => {
    const directives = String(cache || '').toLowerCase().split(',')
      .map(part => part.trim());
    return directives.includes('no-store') && !directives.includes('public');
  };
  const safe = cases.filter(row => cacheSafe(row.cache));
  if (strict) {
    assert.equal(safe.length, cases.length,
      'all viewer 200/206/302/304/401/403/416/500/502 GET/HEAD responses must prohibit storage (issue #284)');
  }
  // Deliberately do not output the synthetic token, viewer URL or any
  // session metadata: the response status and aggregate suffice as evidence.
  console.log('Real shipped Express viewer HTTP cache matrix: ' + cases.length +
    ' GET/HEAD/Range/conditional responses, no-store=' + safe.length + '/' +
    cases.length + '; strict remediation proof: --require-no-store');
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
