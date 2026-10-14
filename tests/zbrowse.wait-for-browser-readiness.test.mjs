// Execute the shipped waitForBrowser() HTTPS readiness decision with an inert,
// synchronous-timeout, locally simulated HTTPS agent. No Docker/network/VPS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-valid-readiness');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const start = source.indexOf('async function waitForBrowser(');
const end = source.indexOf('async function stopContainer(', start);
assert.ok(start >= 0 && end > start,
  'the real HTTPS browser readiness implementation must remain extractable');

async function probe(statusCode, attempts = 2) {
  let requests = 0;
  let resumed = 0;
  let timers = 0;
  const https = {
    Agent: class {
      constructor(options) {
        assert.equal(options.rejectUnauthorized, false,
          'fixture must preserve current internal browser TLS behavior');
      }
    },
    get(url, options, callback) {
      requests++;
      assert.equal(url, 'https://fixture-browser:3001/s/test/');
      assert.equal(options.timeout, 1500, 'readiness probes must have a bounded HTTPS timeout');
      setImmediate(() => callback({
        statusCode,
        resume() { resumed++; }
      }));
      const request = {
        on(type, listener) {
          assert.ok(type === 'timeout' || type === 'error',
            'readiness must continue handling HTTPS request failures');
          assert.equal(typeof listener, 'function');
          return request;
        },
        destroy() {}
      };
      return request;
    }
  };
  const sandbox = {
    https,
    setTimeout(resolve, ms) {
      assert.equal(ms, 1000, 'retry cadence must remain bounded');
      timers++;
      queueMicrotask(resolve);
    }
  };
  const waitForBrowser = vm.runInNewContext(
    source.slice(start, end) + '\nwaitForBrowser',
    sandbox, { filename: 'zbrowse/gateway/server.js', timeout: 1000 }
  );
  let ready;
  try {
    await waitForBrowser('fixture-browser', '/s/test/', attempts);
    ready = true;
  } catch (error) {
    assert.match(String(error.message), /browser did not start/i,
      'readiness rejection must remain an explicit error');
    ready = false;
  }
  assert.equal(requests, ready ? 1 : attempts,
    'readiness should stop at first accepted status or exhaust the bounded retry count');
  assert.equal(resumed, requests, 'every HTTPS response must be drained');
  assert.equal(timers, ready ? 0 : attempts,
    'failed readiness must wait between bounded attempts');
  return ready;
}

assert.equal(await probe(200), true, 'real browser HTTP 200 must be ready');
assert.equal(await probe(500), false, 'real HTTP 500 must not mark a browser ready');
assert.equal(await probe(503), false, 'HTTP 503 service unavailable must not be ready');
assert.equal(await probe(101), false, 'upgrade-only HTTP 101 must not be considered browser readiness');

const redirects = await probe(302);
const notFound = await probe(404);
const throttled = await probe(429);
// A 401 can represent a deliberate viewer Basic authentication challenge. Its
// legitimacy depends on verifying that challenge; do not invent that policy.
const unauthorized = await probe(401);
if (strict) {
  assert.deepEqual({ redirects, notFound, throttled },
    { redirects: false, notFound: false, throttled: false },
    'shipped readiness must not accept redirects, missing browser routes or throttled endpoints (issue #293)');
  console.log('Shipped browser readiness refuses invalid HTTP statuses');
} else {
  console.log('Shipped HTTPS browser readiness decision: HTTP302-ready=' + redirects +
    ', HTTP404-ready=' + notFound + ', HTTP429-ready=' + throttled +
    ', HTTP401-ready=' + unauthorized +
    ' (strict --require-valid-readiness awaits gateway runtime remediation; issue #293)');
}
