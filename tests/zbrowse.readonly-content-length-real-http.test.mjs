// Regression for accepted Content-Length with actual loopback HTTP reads.
// The delivered TV gateway parser must handle valid decimal lengths and
// decompressed streaming budgets. No public origin, Docker or browser tokens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const app = fs.readFileSync(new URL('../zbrowse/gateway/public/app.js', import.meta.url), 'utf8');
const from = app.indexOf('async function cancelQuietly(');
const to = app.indexOf('\nfunction setMessage(', from);
assert.ok(from >= 0 && to > from,
  'real shipped gateway request/parser must be evaluated, never copied');
let scenario;
const traffic = [];
const server = http.createServer((req, res) => {
  traffic.push({ path: req.url, method: req.method });
  assert.equal(req.method, 'GET', 'real localhost QA is strictly read-only');
  scenario(req, res);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = 'http://127.0.0.1:' + server.address().port;
const context = {
  TextDecoder, Uint8Array, URL, AbortSignal,
  setTimeout, clearTimeout,
  fetch: (path, options) => {
    assert.ok(['/api/health', '/api/sites'].includes(path),
      'QA must never contact a session route or public service');
    assert.equal(options.cache, 'no-store', 'readiness reads must bypass cache');
    return fetch(origin + path, { ...options, redirect: 'error' });
  }
};
vm.runInNewContext(app.slice(from, to) + '\nglobalThis.testRequest = request;', context,
  { filename: 'zbrowse/gateway/public/app.js', timeout: 1000 });
const request = context.testRequest;
assert.equal(typeof request, 'function');

const health = { status: 'ok', activeSessions: 0, startingSessions: 0, capacity: 1 };
const sites = {
  sites: [{ name: 'Approved', url: 'https://approved.invalid/' }],
  maxSessionMinutes: 15
};
function send(res, payload, { status = 200, format = 'application/json',
  compress, chunked = false } = {}) {
  const decoded = Buffer.from(JSON.stringify(payload));
  const wire = compress === 'br' ? brotliCompressSync(decoded) :
    compress === 'gzip' ? gzipSync(decoded) : decoded;
  const headers = { 'content-type': format, 'cache-control': 'no-store' };
  if (compress) headers['content-encoding'] = compress;
  if (!chunked) headers['content-length'] = String(wire.byteLength);
  res.writeHead(status, headers).end(wire);
  return { decodedBytes: decoded.byteLength, wireBytes: wire.byteLength };
}

async function check(label, path, responder, expectSuccess) {
  scenario = responder;
  const before = traffic.length;
  const promise = request(path, {
    method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(7000)
  });
  if (expectSuccess) {
    const payload = await promise;
    assert.equal(path === '/api/health' ? payload.status : payload.sites[0].name,
      path === '/api/health' ? 'ok' : 'Approved',
      label + ': legitimate gateway data must survive validation');
  } else {
    await assert.rejects(promise, undefined, label + ': unreviewed bytes must fail closed');
  }
  assert.equal(traffic.length, before + 1, label + ': exactly one HTTP request');
  assert.equal(traffic.at(-1).path, path, label + ': request route matches fixture');
}

try {
  for (const [path, payload] of [['/api/health', health], ['/api/sites', sites]]) {
    await check(path + ' ordinary Content-Length', path,
      (_req, res) => send(res, payload), true);
    for (const compress of ['gzip', 'br']) {
      await check(path + ' ' + compress + ' compressed wire Content-Length', path,
        (_req, res) => send(res, payload, { compress }), true);
    }
    await check(path + ' chunked JSON without Content-Length', path,
      (_req, res) => send(res, payload, { chunked: true }), true);
    await check(path + ' malformed HTML-labelled JSON', path,
      (_req, res) => send(res, payload, { format: 'text/html' }), false);
  }

  let sizes;
  await check('health compressed expansion beyond 4 KiB', '/api/health',
    (_req, res) => {
      sizes = send(res, { ...health, padding: 'z'.repeat(5000) }, { compress: 'br' });
    }, false);
  assert.ok(sizes.wireBytes < 4096 && sizes.decodedBytes > 4096,
    'compressed health fixture must inflate above 4 KiB despite short wire length');
  await check('sites compressed expansion beyond 64 KiB', '/api/sites',
    (_req, res) => {
      sizes = send(res, { ...sites, padding: 'z'.repeat(70000) }, { compress: 'gzip' });
    }, false);
  assert.ok(sizes.wireBytes < 65536 && sizes.decodedBytes > 65536,
    'compressed sites fixture must inflate above 64 KiB despite short wire length');
  await check('health ordinary body above cap', '/api/health',
    (_req, res) => send(res, { ...health, padding: 'x'.repeat(4800) }), false);
  await check('sites ordinary body above cap', '/api/sites',
    (_req, res) => send(res, { ...sites, padding: 'x'.repeat(69000) }), false);
  for (const path of ['/api/health', '/api/sites']) {
    await check(path + ' 502 JSON error never supplies readiness', path,
      (_req, res) => send(res, { error: 'not available' }, { status: 502 }), false);
  }
  console.log('TV read-only Content-Length proof passed: real HTTP plain, ' +
    'chunked, gzip/Brotli and oversized decompression, health + sites');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
