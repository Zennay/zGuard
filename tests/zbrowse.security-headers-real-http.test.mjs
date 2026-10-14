// Real loopback HTTP proof of the exact Helmet middleware configured by the
// shipped gateway. No Docker, browser sessions, external host or live VPS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
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
  const csp = get('content-security-policy') || '';
  // Express finalhandler intentionally overrides the app CSP on generated
  // 400/404 HTML errors with a stricter default-src 'none' policy. Treat
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
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const [label, url, options, expected] of [
      ['JSON success', '/api/health', { method: 'GET' }, 200],
      ['unmatched path', '/not-found', { method: 'GET' }, 404],
      ['invalid JSON body', '/api/health', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not valid JSON'
      }, 400]
    ]) {
      const response = await fetch(base + url, {
        ...options, redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(4000)
      });
      assert.equal(response.status, expected, label + ': source middleware HTTP status');
      verifyHeaders(response.headers, label);
      await response.arrayBuffer();
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
  ['Express fingerprint', 'app.disable("x-powered-by");',
    'app.enable("x-powered-by");'],
  ['CSP inline scripts', 'scriptSrc: ["\'self\'"]',
    'scriptSrc: ["\'unsafe-inline\'"]'],
  ['CSP foreign frames', 'frameSrc: ["\'self\'"]',
    'frameSrc: ["*"]'],
  ['COEP streaming compatibility', 'crossOriginEmbedderPolicy: false',
    'crossOriginEmbedderPolicy: true']
]) {
  assert.ok(source.includes(original), label + ': mutation target missing');
  const changed = source.replace(original, weakened);
  assert.notEqual(changed, source, label + ': fixture must actually be weakened');
  await assert.rejects(probe(changed), undefined,
    label + ': weakening shipped Helmet must fail the real HTTP assertion');
  mutations++;
}
console.log('Shipped gateway Helmet real HTTP: 3 response classes and ' +
  mutations + ' failing policy mutations PASS; live public HTTPS unverified');
