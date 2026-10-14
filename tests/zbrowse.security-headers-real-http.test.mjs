// Real loopback HTTP proof of the exact Helmet middleware configured by the
// shipped gateway. No Docker, browser sessions, external host or live VPS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const helmet = require('helmet');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const begin = source.indexOf('app.set("trust proxy", trustProxyHops);');
const end = source.indexOf('const sessionLimiter = rateLimit(', begin);
assert.ok(begin > 0 && end > begin,
  'real HTTP proof must extract the shipped app trust/header/body middleware');

function verifyHeaders(headers, label) {
  const get = (key) => headers.get(key);
  assert.equal(get('x-powered-by'), null,
    label + ': Express fingerprint must not be exposed');
  assert.equal(get('x-content-type-options'), 'nosniff',
    label + ': MIME sniffing must be disabled');
  assert.equal(get('x-frame-options'), 'SAMEORIGIN',
    label + ': cross-origin UI framing must be denied');
  assert.equal(get('referrer-policy'), 'no-referrer',
    label + ': credentials and navigation paths must not enter Referer');
  assert.equal(get('cross-origin-opener-policy'), 'same-origin',
    label + ': opener relationship must be isolated');
  assert.equal(get('cross-origin-resource-policy'), 'same-origin',
    label + ': cross-origin resources must be isolated');
  assert.equal(get('origin-agent-cluster'), '?1',
    label + ': origin agent isolation must remain enabled');
  assert.match(get('strict-transport-security') || '',
    /^max-age=31536000(?:; includeSubDomains)?$/i,
    label + ': HSTS default must remain active');
  assert.equal(get('cross-origin-embedder-policy'), null,
    label + ': intentional remote browser stream COEP exception must remain');
  assert.equal(get('access-control-allow-origin'), null,
    label + ': untrusted Origin must not receive CORS read permission');
  assert.equal(get('access-control-allow-credentials'), null,
    label + ': gateway must not grant cross-origin credential access');
  assert.equal(get('access-control-allow-methods'), null,
    label + ': gateway must not authorize cross-origin preflight methods');
  assert.equal(get('access-control-allow-headers'), null,
    label + ': gateway must not authorize cross-origin preflight request headers');
  const csp = get('content-security-policy') || '';
  // Express finalhandler intentionally overrides the app CSP on generated
  // 400/404/413 HTML errors with a stricter default-src 'none' policy. Treat
  // that behavior as acceptable only on those explicit error paths.
  if (label !== 'JSON success') {
    assert.equal(csp.trim(), "default-src 'none'",
      label + ': framework error page must emit a deny-all CSP');
    return;
  }
  for (const directive of [
    "default-src 'self'", "script-src 'self'", "style-src 'self'",
    "img-src 'self' data:", "frame-src 'self'",
    "connect-src 'self' wss: ws:", "media-src 'self' blob:",
    "frame-ancestors 'self'"
  ]) assert.ok(csp.split(';').map(s => s.trim()).includes(directive),
    label + ': missing exact browser CSP policy ' + directive);
  assert.doesNotMatch(csp, /'unsafe-inline'|'unsafe-eval'|(?:^|[\s;])\*(?:[\s;]|$)/,
    label + ': unsafe script/stylesheet escape in effective CSP');
}

async function probe(shipped) {
  const app = express();
  const block = shipped.slice(begin, shipped.indexOf('const sessionLimiter = rateLimit(', begin));
  assert.ok(block.includes('app.use(helmet({'),
    'live middleware must include the actual Helmet configuration');
  vm.runInNewContext(block, { app, express, helmet, trustProxyHops: 0 },
    { filename: 'zbrowse/gateway/server.js', timeout: 1000 });
  app.get('/api/health', (_request, reply) => reply.json({ status: 'ok' }));
  // Keep the positive compressed-parser control source-bound to the exact
  // shipped middleware while using a disposable fixture-only route.
  app.post('/api/echo', (request, reply) =>
    reply.json({ accepted: request.body?.padding?.length === 128 }));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const [label, url, options, expected] of [
      ['JSON success', '/api/health', { method: 'GET' }, 200],
      ['JSON success', '/api/health', {
        method: 'GET', headers: { origin: 'https://untrusted.example.invalid' }
      }, 200],
      ['foreign CORS preflight', '/api/health', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://untrusted.example.invalid',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type'
        }
      }, 200],
      ['JSON success', '/api/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: gzipSync(JSON.stringify({ padding: 'Q'.repeat(128) }))
      }, 200],
      ['unmatched path', '/not-found', { method: 'GET' }, 404],
      ['invalid JSON body', '/api/health', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not valid JSON'
      }, 400],
      ['oversized JSON body', '/api/health', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ padding: 'Q'.repeat(9 * 1024) })
      }, 413],
      ['compressed oversized JSON body', '/api/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: gzipSync(JSON.stringify({ padding: 'Q'.repeat(24 * 1024) }))
      }, 413]
    ]) {
      const response = await fetch(base + url, {
        ...options, redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(4000)
      });
      assert.equal(response.status, expected, label + ': source middleware HTTP status');
      verifyHeaders(response.headers, label === 'foreign CORS preflight' ? 'JSON success' : label);
      const body = await response.text();
      if (label === 'JSON success' && url === '/api/echo') {
        assert.deepEqual(JSON.parse(body), { accepted: true },
          'shipped Express parser must decompress and accept bounded JSON');
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
}
await probe(source);

let mutations = 0;
for (const [label, original, weakened] of [
  // Helmet also strips X-Powered-By itself; toggling app.disable alone is
  // not a sufficient negative mutation. Inject an actual later header leak.
  ['Express fingerprint', 'app.use(express.json(',
    'app.use((_req, res, next) => { res.set("X-Powered-By", "Express"); next(); });\napp.use(express.json('],
  ['CSP inline scripts', 'scriptSrc: ["\'self\'"]',
    'scriptSrc: ["\'unsafe-inline\'"]'],
  ['CSP foreign frames', 'frameSrc: ["\'self\'"]',
    'frameSrc: ["*"]'],
  ['COEP streaming compatibility', 'crossOriginEmbedderPolicy: false',
    'crossOriginEmbedderPolicy: true'],
  ['JSON size cap bypass', 'express.json({ limit: "8kb" })',
    'express.json({ limit: "80kb" })'],
  ['foreign CORS origin', 'app.use(express.json(',
    'app.use((_req, res, next) => { res.set("Access-Control-Allow-Origin", "*"); next(); });\napp.use(express.json('],
  ['CORS credentials', 'app.use(express.json(',
    'app.use((_req, res, next) => { res.set("Access-Control-Allow-Credentials", "true"); next(); });\napp.use(express.json('],
  ['CORS preflight methods', 'app.use(express.json(',
    'app.use((_req, res, next) => { res.set("Access-Control-Allow-Methods", "POST"); next(); });\napp.use(express.json('],
  ['CORS preflight headers', 'app.use(express.json(',
    'app.use((_req, res, next) => { res.set("Access-Control-Allow-Headers", "Authorization"); next(); });\napp.use(express.json(']
]) {
  assert.ok(source.includes(original), label + ': mutation target missing');
  const changed = source.replace(original, weakened);
  assert.notEqual(changed, source, label + ': fixture must actually be weakened');
  await assert.rejects(probe(changed),
    error => error?.code === 'ERR_ASSERTION' &&
      /(?:JSON success|oversized JSON body|compressed oversized JSON body):/.test(error.message),
    label + ': changed middleware must fail the actual HTTP header assertion, not syntax parsing');
  mutations++;
}
console.log('Shipped gateway Helmet real HTTP: 200/400/404/413, gzip-inflate, CORS preflight and ' +
  mutations + ' failing policy mutations PASS; live public HTTPS unverified');
