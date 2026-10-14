import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const chromiumBackground = read("chromium/background.js");
const firefoxBackground = read("firefox/background.js");
const chromiumContent = read("chromium/content.js");
const firefoxContent = read("firefox/content.js");
const workflow = read(".github/workflows/zguard-cross-browser-parity.yml");

function extractArray(source, name) {
  const match = source.match(new RegExp("const\\s+" + name + "\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;"));
  assert.ok(match, `missing ${name}`);
  return Array.from(vm.runInNewContext(match[1]));
}

function extractSetArray(source, name) {
  const match = source.match(new RegExp("const\\s+" + name + "\\s*=\\s*new Set\\((\\[[\\s\\S]*?\\])\\)\\s*;"));
  assert.ok(match, `missing Set ${name}`);
  return Array.from(vm.runInNewContext(match[1]));
}

function messageTypes(source) {
  return [...source.matchAll(/message\?\.type === ['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .sort();
}

function emittedEvents(source) {
  return [...source.matchAll(/send\(['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .sort();
}

const chromiumBackgroundHosts = extractArray(chromiumBackground, "HOSTILE_HOSTS");
const firefoxBackgroundHosts = extractArray(firefoxBackground, "HOSTILE_HOSTS");
const chromiumContentHosts = extractSetArray(chromiumContent, "HOSTILE_HOSTS");
const firefoxContentHosts = extractSetArray(firefoxContent, "HOSTILE_HOSTS");

assert.ok(chromiumBackgroundHosts.length > 0, "hostile-host policy must not become empty");
assert.deepEqual(
  chromiumBackgroundHosts,
  firefoxBackgroundHosts,
  "Chromium and Firefox background hostile-host policy must stay identical"
);
assert.deepEqual(
  chromiumContentHosts,
  firefoxContentHosts,
  "Chromium and Firefox content-script hostile-host policy must stay identical"
);
assert.deepEqual(
  chromiumContentHosts,
  chromiumBackgroundHosts,
  "Chromium background and content hostile-host policy must stay aligned"
);
assert.deepEqual(
  firefoxContentHosts,
  firefoxBackgroundHosts,
  "Firefox background and content hostile-host policy must stay aligned"
);

const expectedMessageTypes = ["blocked-event", "get-settings", "set-settings"].sort();
assert.deepEqual(
  messageTypes(chromiumBackground),
  expectedMessageTypes,
  "Chromium runtime message contract must remain complete"
);
assert.deepEqual(
  messageTypes(firefoxBackground),
  expectedMessageTypes,
  "Firefox runtime message contract must remain complete"
);

const expectedEvents = ["external-link", "window-open"].sort();
const chromiumEvents = emittedEvents(chromiumContent);
const firefoxEvents = emittedEvents(firefoxContent);
for (const [name, events] of [["Chromium", chromiumEvents], ["Firefox", firefoxEvents]]) {
  assert.deepEqual(
    [...new Set(events)].sort(), expectedEvents,
    name + " blocked-event telemetry types must remain complete"
  );
  assert.equal(
    events.filter((event) => event === "external-link").length, 2,
    name + " must emit the same reviewed external-link event for both clicks and forms"
  );
}
assert.deepEqual(chromiumEvents, firefoxEvents,
  "Chromium and Firefox telemetry entry points must retain exact parity");

for (const [name, source] of [
  ["Chromium background", chromiumBackground],
  ["Firefox background", firefoxBackground],
  ["Chromium content", chromiumContent],
  ["Firefox content", firefoxContent]
]) {
  assert.match(source, /mode:\s*['"]balanced['"]/, `${name}: balanced must remain the safe default`);
  assert.match(source, /mode === ['"]strict['"]/, `${name}: strict mode behavior must remain explicit`);
}

for (const expected of [
  'repository: ${{ github.event.pull_request.head.repo.full_name || github.repository }}',
  'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
  'EXPECTED_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
  'run: test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'
]) {
  assert.ok(
    workflow.includes(expected),
    `cross-browser workflow must retain exact-head checkout proof: ${expected}`
  );
}
assert.ok(
  workflow.includes("persist-credentials: false"),
  "cross-browser checkout must not persist credentials"
);


// Real-browser acceptance is authoritative only if it still exercises the
// shipped popup-target repairs. Lock its negative AND allowed navigation
// controls, so editing the browser fixture cannot yield a false green CI run.
const chromiumAcceptance = read("tests/zguard.chromium-real-browser.test.mjs");
const firefoxAcceptance = read("tests/zguard.firefox-real-browser.test.mjs");
function verifyPopupBrowserEvidence(chromium, firefox) {
  for (const needle of [
    "const targets = { mixedCase: '_BlAnK', named: 'adPopupWindow' };",
    "observed.popupTargets = targetResult.result?.value;",
    "matrix?.hostile, { blocked: true, cancelled: true }",
    "for (const safe of ['ordinary', 'sameOrigin'])",
    "matrix?.[safe], { blocked: false, cancelled: true }",
    "anchor.addEventListener('click', cancelAllowed);",
    "anchor.dispatchEvent(event);"
  ]) {
    assert.ok(chromium.includes(needle),
      "real Chromium must exercise protected + allowed named popup targets: " + needle);
  }
  for (const needle of [
    "['namedHostile','adPopupWindow'",
    "['namedOrdinary','adPopupWindow'",
    "['mixedHostile','_BlAnK'",
    "['mixedOrdinary','_BlAnK'",
    "for(const [id] of targetCases)await click('#qa'+id);",
    "assert.equal(after.popupTargetClicks[id],0",
    "assert.equal(after.popupTargetClicks[id],1",
    "event.preventDefault();"
  ]) {
    assert.ok(firefox.includes(needle),
      "real native Firefox must exercise protected + allowed popup targets: " + needle);
  }
}
verifyPopupBrowserEvidence(chromiumAcceptance, firefoxAcceptance);
for (const [label, base, needle, replacement] of [
  ['Chrome hostile assertion', chromiumAcceptance,
    "matrix?.hostile, { blocked: true, cancelled: true }",
    "matrix?.hostile, { blocked: false, cancelled: true }"],
  ['Chrome navigation positive control', chromiumAcceptance,
    "matrix?.[safe], { blocked: false, cancelled: true }",
    "matrix?.[safe], { blocked: true, cancelled: true }"],
  ['Firefox native click entrypoint', firefoxAcceptance,
    "for(const [id] of targetCases)await click('#qa'+id);",
    "for(const [id] of [])await click('#qa'+id);"],
  ['Firefox hostile assertion', firefoxAcceptance,
    "assert.equal(after.popupTargetClicks[id],0",
    "assert.equal(after.popupTargetClicks[id],1"]
]) {
  assert.ok(base.includes(needle), label + ": mutation fixture must exist");
  const mutated = base.replace(needle, replacement);
  assert.notEqual(mutated, base, label + ": mutated source must change");
  assert.throws(() => verifyPopupBrowserEvidence(
    base === chromiumAcceptance ? mutated : chromiumAcceptance,
    base === firefoxAcceptance ? mutated : firefoxAcceptance
  ), { code: 'ERR_ASSERTION' },
  label + ": weakened browser evidence must fail QA");
}

console.log("zGuard cross-browser contract parity passed");
