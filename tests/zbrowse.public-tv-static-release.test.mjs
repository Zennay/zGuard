// Explicitly dispatched, GET-only public TV release identity check for #293.
// Normal PR and push CI invokes --self-test, never --live.
// No sessions, bearer paths, credentials, Docker or browser allocation.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const PUBLIC_ORIGIN = 'https://zbrowse-tv.lizellay.chatgpt.site/';
const reviewedAssets = [
  ['/', '../zbrowse/gateway/public/index.html', ['text/html']],
  ['/app.js', '../zbrowse/gateway/public/app.js',
    ['text/javascript', 'application/javascript']],
  ['/styles.css', '../zbrowse/gateway/public/styles.css', ['text/css']]
].map(([route, localPath, mediaTypes]) => {
  const bytes = fs.readFileSync(new URL(localPath, import.meta.url));
  assert.ok(bytes.length > 0, route + ': audited source must not be empty');
  return {
    route, bytes, mediaTypes,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  };
});
const reviewed = new Map(reviewedAssets.map(item => [item.route, item]));
assert.equal(reviewed.size, 3, 'all three required static release assets must be unique');

// A rejected public asset must stop downloading even when the upstream
// cancellation promise rejects or never settles. Preserve the original error.
async function cancelQuietly(cancel) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(cancel).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 250); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The same deadline must cover the entire response, including body reads.
// Some fetch adapters stop waiting for headers but not a stalled reader.read().
function readWithSignal(reader, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  let abort;
  const timedOut = new Promise((_, reject) => {
    abort = () => reject(signal.reason || new Error('Static asset read timeout'));
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([reader.read(), timedOut]).finally(() =>
    signal.removeEventListener('abort', abort));
}

export async function verifyPublicStaticRelease(
  fetcher = globalThis.fetch, publicOrigin = PUBLIC_ORIGIN
) {
  const origin = new URL(publicOrigin);
  assert.equal(origin.href, PUBLIC_ORIGIN,
    'static release probe may use only the reviewed TV origin');
  const result = [];
  for (const asset of reviewedAssets) {
    const target = new URL(asset.route, origin);
    assert.equal(target.origin, origin.origin, 'public assets must be same-origin');
    const signal = AbortSignal.timeout(7000);
    const response = await fetcher(target.href, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { accept: asset.mediaTypes[0] },
      signal
    });
    try {
      assert.equal(response.status, 200,
        asset.route + ': production asset must return exactly HTTP 200');
      const mediaType = (response.headers.get('content-type') || '')
        .split(';', 1)[0].trim().toLowerCase();
      assert.ok(asset.mediaTypes.includes(mediaType),
        asset.route + ': production asset has wrong content type');
      const length = response.headers.get('content-length');
      if (length !== null) {
        assert.match(length, /^[0-9]+$/, asset.route + ': invalid length header');
        assert.ok(BigInt(length) <= BigInt(asset.bytes.length),
          asset.route + ': advertised body exceeds audited release asset');
      }
      assert.ok(response.body, asset.route + ': missing response body');
    } catch (error) {
      // A proxy 502, HTML fallback or huge declared response can otherwise
      // keep streaming after the release identity is already rejected.
      await cancelQuietly(() => response.body?.cancel());
      throw error;
    }
    // Compare the *decoded* bytes, not a CDN/transfer Content-Length.
    // Reject overflows and malformed chunks before hashing other content.
    const reader = response.body.getReader();
    const hash = crypto.createHash('sha256');
    let bytesRead = 0;
    try {
      for (;;) {
        const { value, done } = await readWithSignal(reader, signal);
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw new Error(asset.route + ': invalid public asset stream chunk');
        }
        bytesRead += value.byteLength;
        if (bytesRead > asset.bytes.length) {
          throw new Error(asset.route + ': streamed asset exceeds audited release size');
        }
        hash.update(value);
      }
    } catch (error) {
      await cancelQuietly(() => reader.cancel());
      throw error;
    } finally {
      try { reader.releaseLock(); } catch { /* An aborted read may still be pending. */ }
    }
    assert.equal(bytesRead, asset.bytes.length,
      asset.route + ': production asset length does not match audited source');
    assert.equal(hash.digest('hex'), asset.sha256,
      asset.route + ': production asset hash differs from reviewed checkout');
    result.push({ route: asset.route, verified: true });
  }
  return result;
}

function readOnlyMode(args) {
  if (args.length !== 1 || !['--self-test', '--live'].includes(args[0])) {
    throw new Error('Exactly one static release mode required: --self-test or --live');
  }
  return args[0];
}

// True HTTP/1.1 loopback proof: an invalid production asset must close its
// network transfer. No public endpoints, tokens, sessions or remote browsers.
async function realTcpStaticReleaseAcceptance() {
  let scenario = null;
  const seen = [];
  let unexpectedRedirects = 0;
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, route: req.url });
    const asset = reviewed.get(req.url);
    if (req.method !== 'GET' || !asset) {
      unexpectedRedirects++;
      res.writeHead(405);
      res.end();
      return;
    }
    if (scenario && scenario.route === req.url) {
      const active = scenario;
      if (active.mode === 'silent') {
        req.socket.once('close', () => { active.closed = true; });
        return; // Accept TCP and GET, but never send even the HTTP headers.
      }
      if (active.mode === 'redirect') {
        res.writeHead(302, { location: '/unexpected-redirect-target' });
        res.end();
        return;
      }
      if (active.mode?.startsWith('compressed-')) {
        const source = Buffer.from(asset.bytes);
        if (active.mode === 'compressed-tampered') source[0] ^= 1;
        const isBrotli = active.algorithm === 'br';
        const compressed = isBrotli ? brotliCompressSync(source) : gzipSync(source);
        res.writeHead(200, {
          'content-type': asset.mediaTypes[0],
          'content-encoding': isBrotli ? 'br' : 'gzip',
          'content-length': String(compressed.length),
          'cache-control': 'no-store'
        });
        res.end(compressed);
        return;
      }
      res.once('close', () => { active.closed = true; });
      res.writeHead(active.status, {
        'content-type': active.contentType,
        ...active.headers
      });
      res.write(active.bytes);
      return; // Deliberately keep error/oversize/stalled bodies open.
    }
    res.writeHead(200, { 'content-type': asset.mediaTypes[0],
      'cache-control': 'no-store' });
    res.end(asset.bytes);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const local = 'http://127.0.0.1:' + server.address().port;
  const localFetch = (raw, options) => {
    const url = new URL(raw);
    assert.equal(url.origin, new URL(PUBLIC_ORIGIN).origin,
      'only reviewed public identity URLs may be mapped to loopback');
    assert.ok(reviewed.has(url.pathname),
      'only reviewed static routes may be mapped to loopback');
    assert.equal(options.method, 'GET', 'static HTTP proof must be GET-only');
    assert.equal(options.credentials, 'omit', 'static HTTP proof cannot send credentials');
    assert.equal(options.redirect, 'error', 'redirects must fail closed');
    return fetch(local + url.pathname, options);
  };
  try {
    for (const [route, status, contentType, headers, bytes, message] of [
      ['/', 503, 'text/html', {}, '<html>bad gateway</html>', /exactly HTTP 200/],
      ['/app.js', 200, 'text/html', {}, '<html>fallback</html>', /wrong content type/],
      ['/styles.css', 200, 'text/css', { 'content-length': '999999' },
        'x', /advertised body exceeds audited release asset/],
      ['/app.js', 200, 'application/javascript', {},
        Buffer.alloc(reviewed.get('/app.js').bytes.length + 1, 32),
        /streamed asset exceeds audited release size/]
    ]) {
      scenario = { route, status, contentType, headers, bytes, closed: false };
      const active = scenario;
      await assert.rejects(verifyPublicStaticRelease(localFetch), message,
        route + ': rejected asset must fail the release gate');
      for (let i = 0; i < 60 && !active.closed; i++)
        await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(active.closed, true,
        route + ': server must observe actual connection teardown within 3 seconds');
    }
    // A gateway that never finishes a correct-looking JS stream and another
    // that never sends CSS headers must both expire through the 7s app signal.
    for (const [route, mode, bytes] of [
      ['/app.js', 'body', ' '],
      ['/styles.css', 'silent', '']
    ]) {
      scenario = {
        route, mode, bytes, status: 200,
        contentType: reviewed.get(route).mediaTypes[0],
        headers: {}, closed: false
      };
      const active = scenario;
      let watchdog;
      const started = Date.now();
      try {
        await assert.rejects(Promise.race([
          verifyPublicStaticRelease(localFetch),
          new Promise((_, reject) => {
            watchdog = setTimeout(() =>
              reject(new Error('test watchdog expired without client timeout')), 11000);
          })
        ]), /aborted|time(?:d)? ?out/i,
        route + ': real stalled response must expire from client deadline');
      } finally {
        clearTimeout(watchdog);
      }
      assert.ok(Date.now() - started >= 5500 && Date.now() - started < 10500,
        route + ': stalled response must time out near the 7s deadline');
      for (let i = 0; i < 60 && !active.closed; i++)
        await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(active.closed, true,
        route + ': timed-out HTTP response must close the real connection');
    }
    // Production CDNs commonly gzip or Brotli assets. HTTP Content-Length
    // describes compressed *wire* bytes, while the audited hash must be
    // computed over the decoded HTML/JS/CSS. Exercise actual Node fetch
    // decompression over TCP rather than a fake in-memory Response.
    for (const algorithm of ['gzip', 'br']) {
      for (const route of ['/', '/app.js', '/styles.css']) {
        scenario = { route, mode: 'compressed-valid', algorithm };
        const unchanged = await verifyPublicStaticRelease(localFetch);
        assert.deepEqual(unchanged.map(item => item.route),
          ['/', '/app.js', '/styles.css'],
          algorithm + ' ' + route + ': compressed audited release must remain valid');
      }
    }
    // Same media type, same uncompressed byte count, and legitimate gzip
    // framing cannot hide tampered JS that fails the checked-out SHA256.
    scenario = {
      route: '/app.js', mode: 'compressed-tampered', algorithm: 'gzip'
    };
    await assert.rejects(verifyPublicStaticRelease(localFetch),
      /hash differs from reviewed checkout/,
      'gzip must not make modified JavaScript look like the reviewed release');
    scenario = {
      route: '/styles.css', mode: 'compressed-tampered', algorithm: 'br'
    };
    await assert.rejects(verifyPublicStaticRelease(localFetch),
      /hash differs from reviewed checkout/,
      'Brotli must not make modified CSS look like the reviewed release');

    scenario = { route: '/', mode: 'redirect', closed: false };
    await assert.rejects(verifyPublicStaticRelease(localFetch),
      /fetch failed|redirect/i, 'HTTP redirect must never certify the wrong public static identity');
    assert.equal(unexpectedRedirects, 0,
      'redirect refusal must happen before contacting a second path');
    scenario = null;
    const recovered = await verifyPublicStaticRelease(localFetch);
    assert.deepEqual(recovered.map(item => item.route), ['/', '/app.js', '/styles.css'],
      'unchanged audited assets must recover after bad live transport cases');
    assert.ok(seen.length >= 10, 'real HTTP requests must reach loopback server');
    assert.ok(seen.every(({ method, route }) =>
      method === 'GET' && reviewed.has(route)),
    'no unexpected methods, session routes or redirected requests are allowed');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function selfTest() {
  const requests = [];
  const fixture = async (url, options) => {
    const route = new URL(url).pathname;
    const asset = reviewed.get(route);
    assert.ok(asset, 'unexpected public static asset URL');
    requests.push({ route, options });
    return new Response(asset.bytes, {
      status: 200, headers: { 'content-type': asset.mediaTypes[0] }
    });
  };
  const normal = await verifyPublicStaticRelease(fixture);
  assert.deepEqual(normal.map(item => item.route), ['/', '/app.js', '/styles.css']);
  assert.deepEqual(requests.map(item => item.route), ['/', '/app.js', '/styles.css']);
  assert.ok(requests.every(({ options }) =>
    options.method === 'GET' && options.redirect === 'error' &&
    options.credentials === 'omit' && options.cache === 'no-store' &&
    options.referrerPolicy === 'no-referrer' &&
    Object.keys(options.headers).every(name => name === 'accept') &&
    options.signal instanceof AbortSignal
  ), 'production static release acceptance must be credential-free and GET-only');

  const failure = (route, faulty) => verifyPublicStaticRelease(async url => {
    const path = new URL(url).pathname;
    const asset = reviewed.get(path);
    if (path === route) return faulty(asset);
    return new Response(asset.bytes, {
      status: 200, headers: { 'content-type': asset.mediaTypes[0] }
    });
  });

  await assert.rejects(failure('/', asset => new Response(
    '<html>TV placeholder</html>', {
      headers: { 'content-type': asset.mediaTypes[0] }
    })), /length does not match audited source/,
  'unconnected public landing placeholder must not count as a deployed UI');

  await assert.rejects(failure('/app.js', asset => new Response(
    asset.bytes, { headers: { 'content-type': 'text/html' } }
  )), /wrong content type/,
  'HTML fallback masquerading as browser JavaScript must fail');

  await assert.rejects(failure('/styles.css', asset => new Response(
    asset.bytes, { status: 302, headers: { 'content-type': 'text/css' } }
  )), /exactly HTTP 200/,
  'redirect responses must not impersonate a real release');

  await assert.rejects(failure('/app.js', asset => {
    const altered = Buffer.from(asset.bytes);
    altered[0] ^= 1;
    return new Response(altered, { headers: { 'content-type': asset.mediaTypes[0] } });
  }), /hash differs from reviewed checkout/,
  'same-size changed release must fail content integrity');

  await assert.rejects(failure('/app.js', asset =>
    new Response(asset.bytes, {
      headers: {
        'content-type': asset.mediaTypes[0],
        'content-length': String(asset.bytes.length + 1)
      }
    })), /advertised body exceeds audited release asset/,
  'a declared oversize payload must fail before being downloaded');

  await assert.rejects(failure('/styles.css', asset => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(asset.bytes);
        controller.enqueue(new Uint8Array([32]));
        controller.close();
      }
    }), { headers: { 'content-type': 'text/css' } }
  )), /streamed asset exceeds audited release size/,
  'an unknown-length oversized stream must fail closed');


  // Rejected responses must be cancelled before reading any untrusted body.
  // Each asset gets an independent one-shot stream with no prefetch.
  for (const route of ['/', '/app.js', '/styles.css']) {
    const asset = reviewed.get(route);
    for (const [label, status, contentType, headers, expected] of [
      ['HTTP 503', 503, asset.mediaTypes[0], {}, /exactly HTTP 200/],
      ['HTML fallback', 200, 'application/x-unreviewed', {}, /wrong content type/],
      ['oversized declared length', 200, asset.mediaTypes[0],
        { 'content-length': String(asset.bytes.length + 1) }, /advertised body exceeds/],
      ['invalid declared length', 200, asset.mediaTypes[0],
        { 'content-length': 'NaN' }, /invalid length header/]
    ]) {
      let cancels = 0;
      let reads = 0;
      const faulty = new Response(new ReadableStream({
        pull() { reads++; throw new Error('failed preflight still read the body'); },
        cancel() { cancels++; }
      }, { highWaterMark: 0 }), {
        status, headers: { 'content-type': contentType, ...headers }
      });
      await assert.rejects(failure(route, () => faulty), expected,
        route + ': ' + label + ' must fail closed');
      assert.equal(reads, 0, route + ': ' + label + ' must not read the body');
      assert.equal(cancels, 1, route + ': ' + label + ' must cancel the transfer once');
    }
    // A streamed oversize is also rejected and cancelled, rather than
    // releasing the stream lock and leaving the transfer open.
    let reads = 0;
    let cancels = 0;
    const overflow = new Response(new ReadableStream({
      pull(controller) {
        reads++;
        if (reads === 1) controller.enqueue(new Uint8Array(asset.bytes.length + 1));
        else throw new Error('unexpected follow-on read');
      },
      cancel() { cancels++; }
    }, { highWaterMark: 0 }), { headers: { 'content-type': asset.mediaTypes[0] } });
    await assert.rejects(failure(route, () => overflow),
      /streamed asset exceeds audited release size/);
    assert.equal(reads, 1, route + ': oversized first chunk must stop extra reads');
    assert.equal(cancels, 1, route + ': oversized stream must be cancelled');
  }

  // Even a permanently hanging cancel cannot delay a failed release check
  // indefinitely or replace the original size-limit rejection.
  let pendingCancels = 0;
  const neverSettles = new Response(new ReadableStream({
    cancel() { pendingCancels++; return new Promise(() => {}); }
  }, { highWaterMark: 0 }), {
    headers: { 'content-type': 'text/html',
      'content-length': String(reviewed.get('/').bytes.length + 1) }
  });
  const began = Date.now();
  await assert.rejects(failure('/', () => neverSettles),
    /advertised body exceeds audited release asset/);
  assert.equal(pendingCancels, 1, 'failed release must still attempt cancellation');
  assert.ok(Date.now() - began < 1500,
    'a never-settling cancel() must not hang the public release gate');

  await assert.rejects(verifyPublicStaticRelease(fixture,
    'https://outside.invalid/'), /reviewed TV origin/,
  'the probe must not accept an alternate destination');

  for (const args of [
    [], ['--liv'], ['--live', '--self-test'],
    ['--self-test', '--live'], ['--live', '--live'], ['--self-test=true']
  ]) {
    assert.throws(() => readOnlyMode(args), /Exactly one static release mode/);
    const child = spawnSync(process.execPath, [process.argv[1], ...args], {
      encoding: 'utf8', timeout: 5000
    });
    assert.equal(child.status, 1, 'bad options must fail without a public GET');
    assert.match(child.stderr, /Exactly one static release mode/);
    assert.doesNotMatch(child.stdout, /static release identity verified/);
  }
  await realTcpStaticReleaseAcceptance();
  console.log('zBrowse public TV static release identity self-test passed (GET-only)');
}

const mode = readOnlyMode(process.argv.slice(2));
if (mode === '--self-test') {
  await selfTest();
} else {
  const assets = await verifyPublicStaticRelease();
  console.log('zBrowse public TV static release identity verified: ' +
    assets.map(item => item.route).join(', '));
}
