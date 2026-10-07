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
assert.deepEqual(
  emittedEvents(chromiumContent),
  expectedEvents,
  "Chromium blocked-event telemetry contract must remain complete"
);
assert.deepEqual(
  emittedEvents(firefoxContent),
  expectedEvents,
  "Firefox blocked-event telemetry contract must remain complete"
);

for (const [name, source] of [
  ["Chromium background", chromiumBackground],
  ["Firefox background", firefoxBackground],
  ["Chromium content", chromiumContent],
  ["Firefox content", firefoxContent]
]) {
  assert.match(source, /mode:\s*['"]balanced['"]/, `${name}: balanced must remain the safe default`);
  assert.match(source, /mode === ['"]strict['"]/, `${name}: strict mode behavior must remain explicit`);
}

console.log("zGuard cross-browser contract parity passed");
