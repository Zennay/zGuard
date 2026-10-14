// Keep public release readiness and the actual TV on the SAME streamed JSON
// byte limits. An offline green probe must never certify a larger unbounded
// browser-side JSON.parse() path. No network calls or browser are needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(
  new URL('../zbrowse/gateway/public/app.js', import.meta.url), 'utf8');
const readiness = fs.readFileSync(
  new URL('./zbrowse.public-origin-readiness.test.mjs', import.meta.url), 'utf8');

function verify(tv, probe) {
  const tvBudget = /boundedGatewayJson\(response,\s*url === "\/api\/health" \? (\d+) : (\d+), options\.signal\)/.exec(tv);
  const publicBudget = /const maximumBytes = route === '\/api\/health' \? (\d+) : (\d+);/.exec(probe);
  assert.ok(tvBudget, 'TV must actually invoke the bounded reader for both public GETs');
  assert.ok(publicBudget, 'public release probe must retain route-specific byte bounds');
  assert.deepEqual(tvBudget.slice(1).map(Number), [4096, 65536],
    'TV health/sites byte limits must remain the reviewed 4KiB/64KiB values');
  assert.deepEqual(tvBudget.slice(1), publicBudget.slice(1),
    'TV and independent public release probe limits must agree exactly');
  const streamSource = tv.slice(tv.indexOf('async function boundedGatewayJson('),
    tv.indexOf('\nasync function request('));
  assert.ok(streamSource.startsWith('async function boundedGatewayJson('),
    'TV must implement bounded JSON reading before request()');
  for (const [name, line] of [
    ['Content-Length preflight', 'BigInt(declared) > BigInt(maximumBytes)'],
    ['actual ReadableStream access', 'response.body.getReader()'],
    ['fatal UTF-8 decoder', 'new TextDecoder("utf-8", { fatal: true })'],
    ['accumulated byte accounting', 'received += value.byteLength'],
    ['actual streamed-byte cap', 'if (received > maximumBytes)'],
    ['cancel oversized stream', 'await cancelQuietly(() => reader.cancel())'],
    ['read against request deadline', 'await readWithSignal(reader, signal)'],
    ['release reader lock', 'reader.releaseLock()'],
    ['parse only bounded text', 'return JSON.parse(decoded)']
  ]) {
    assert.ok(streamSource.includes(line), name + ' is required in shipped TV parser');
  }
  // Ordinary browser/cache tests must still have the seven-second network
  // timeout: a byte cap alone cannot stop indefinitely trickled tiny chunks.
  assert.ok(tv.includes('await boundedGatewayJson(response, url === "/api/health" ? 4096 : 65536, options.signal)'),
    'bounded JSON reader must receive the same fetch abort signal');
  assert.ok(tv.includes('AbortSignal.timeout(7000)'),
    'gateway read limits must be paired with bounded network waiting');
}

verify(app, readiness);
let mutations = 0;
for (const [label, source, oldPart, newPart] of [
  ['raise TV health cap', 'tv', '? 4096 : 65536', '? 8192 : 65536'],
  ['raise TV catalogue cap', 'tv', '? 4096 : 65536', '? 4096 : 1048576'],
  ['raise release-probe cap', 'probe', '? 4096 : 65536', '? 4096 : 131072'],
  ['skip Content-Length preflight', 'tv',
    'BigInt(declared) > BigInt(maximumBytes)', 'false'],
  ['allow unbounded streaming', 'tv', 'if (received > maximumBytes)', 'if (false)'],
  ['omit cancel', 'tv', 'await cancelQuietly(() => reader.cancel())', 'void 0'],
  ['remove streamed abort enforcement', 'tv',
    'await readWithSignal(reader, signal)', 'await reader.read()'],
  ['drop signal forwarding', 'tv',
    'boundedGatewayJson(response, url === "/api/health" ? 4096 : 65536, options.signal)',
    'boundedGatewayJson(response, url === "/api/health" ? 4096 : 65536)'],
  ['ignore invalid UTF-8', 'tv', 'new TextDecoder("utf-8", { fatal: true })',
    'new TextDecoder("utf-8")'],
  ['parse unbounded direct response', 'tv',
    'boundedGatewayJson(response, url === "/api/health" ? 4096 : 65536, options.signal)',
    'response.json()'],
]) {
  const initial = source === 'tv' ? app : readiness;
  assert.ok(initial.includes(oldPart), label + ': mutation anchor must exist');
  const changed = initial.replace(oldPart, newPart);
  assert.notEqual(changed, initial, label + ': negative mutation must change source');
  assert.throws(() => verify(source === 'tv' ? changed : app,
    source === 'probe' ? changed : readiness), undefined,
  label + ': corrupted byte-bound release evidence must be rejected');
  mutations++;
}
console.log('TV/public JSON byte-budget integrity passed: 4KiB health, 64KiB sites, ' +
  mutations + ' negative source mutations');
