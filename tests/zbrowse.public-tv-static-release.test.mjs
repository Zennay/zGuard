// Explicitly dispatched, GET-only public TV release identity check for #293.
// Normal PR and push CI invokes --self-test, never --live.
// No sessions, bearer paths, credentials, Docker or browser allocation.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

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
