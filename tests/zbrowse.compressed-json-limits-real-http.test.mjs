// The shipped Express JSON parser must enforce its 8kb cap AFTER inflation,
// not merely on a tiny compressed request body. Real loopback HTTP only.
// No Docker, public gateway, browser, session token, or production traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const shippedParser = source.match(/app\.use\(express\.json\(\{ limit: "8kb" \}\)\);/)?.[0];
assert.ok(shippedParser,
  'fixture must execute the actual bounded JSON parser from shipped server.js');
const codecs = [
  ['gzip', gzipSync],
  ['deflate', deflateSync],
  ['br', brotliCompressSync]
];

async function probe(parser, mode) {
  const app = express();
  vm.runInNewContext(parser, { app, express },
    { filename: 'zbrowse/gateway/server.js', timeout: 1000 });
  // Disposable fixture-only route after the shipped production middleware.
  app.post('/qa/echo', (request, reply) => reply.json({
    accepted: request.body?.padding?.length === 128
  }));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/qa/echo';
    const small = JSON.stringify({ padding: 'x'.repeat(128) });
    const inflated = JSON.stringify({ padding: 'Q'.repeat(32 * 1024) });
    // Real Transfer-Encoding: chunked traffic must obey the *same*
    // decompressed cap despite carrying no Content-Length. Use Node HTTP's
    // raw request stream rather than fetch(), which normally fixes length
    // for Buffer request bodies.
    async function sendChunked(body, codec) {
      const payload = Buffer.from(body);
      return await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port: server.address().port,
          method: 'POST', path: '/qa/echo',
          headers: {
            'content-type': 'application/json',
            'content-encoding': codec,
            'transfer-encoding': 'chunked'
          }
        }, res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8')
          }));
          res.once('error', reject);
        });
        req.setTimeout(4000, () => req.destroy(new Error('loopback chunked body timed out')));
        req.once('error', reject);
        const split = Math.max(1, Math.floor(payload.length / 3));
        req.write(payload.subarray(0, split));
        req.write(payload.subarray(split, 2 * split));
        req.end(payload.subarray(2 * split));
      });
    }
    for (const [codec, compress] of codecs) {
      const under = compress(small);
      const bomb = compress(inflated);
      assert.ok(bomb.length < 8 * 1024,
        codec + ': negative fixture must be smaller on wire than the JSON limit');
      for (const [body, expected, label] of [
        [under, 200, 'bounded'],
        [bomb, 413, 'oversized']
      ]) {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-encoding': codec,
            'content-length': String(body.length)
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(4000)
        });
        assert.equal(response.status, expected,
          codec + ' ' + label + ': real HTTP parser must ' +
          (expected === 413 ? 'reject expanded JSON above 8kb' : 'accept bounded JSON'));
        const responseBody = await response.text();
        if (expected === 200) {
          assert.deepEqual(JSON.parse(responseBody), { accepted: true },
            codec + ': valid compressed JSON must be decoded by shipped parser');
        } else {
          assert.doesNotMatch(responseBody, /Q{32}/,
            codec + ': oversize error must not reflect request payload');
        }
        const chunked = await sendChunked(body, codec);
        assert.equal(chunked.status, expected,
          codec + ' ' + label + ': real HTTP chunked parser must enforce decompressed 8kb cap');
        if (expected === 200) {
          assert.deepEqual(JSON.parse(chunked.body), { accepted: true },
            codec + ': chunked valid compressed JSON must reach the actual route');
        } else {
          assert.doesNotMatch(chunked.body, /Q{32}/,
            codec + ': chunked oversized JSON may not be echoed into an error');
        }
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
}
await probe(shippedParser, 'baseline');

// Mutations must fail because of observed network behavior rather than
// syntax/runtime errors or missing fixtures; no passing mocked body parser.
let negatives = 0;
for (const [label, altered] of [
  ['expanded limit', shippedParser.replace('limit: "8kb"', 'limit: "96kb"')],
  ['inflation disabled', shippedParser.replace('limit: "8kb"',
    'limit: "8kb", inflate: false')]
]) {
  assert.notEqual(altered, shippedParser, label + ': change real parser source');
  await assert.rejects(probe(altered, label),
    error => error?.code === 'ERR_ASSERTION' &&
      /(?:gzip|deflate|br) (?:bounded|oversized): real HTTP (?:chunked )?parser/.test(error.message),
    label + ': must fail a real HTTP status assertion, not missing setup');
  negatives++;
}
console.log('Shipped Express JSON inflate limit: 3 real HTTP codecs, ' +
  '12 fixed-length/chunked positive/negative requests, ' + negatives +
  ' failing parser mutations; no VPS or public gateway touched');
