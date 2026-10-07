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
  return vm.runInNewContext(match[1]);
}

function extractSetArray(source, name) {
  const match = source.match(new RegExp("const\\s+" + name + "\\s*=\\s*new Set\\((\\[[\\s\\S]*?\\])\\)\\s*;"));
  assert.ok(match, `missing Set ${name}`);
  return vm.runInNewContext(match[1]);
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

assert.deepEqual(
  extractArray(chromiumBackground, "HOSTILE_HOSTS"),
  extractArray(firefoxBackground, "HOSTILE_HOSTS"),
  "Chromium and Firefox background hostile-host policy must stay identical"
);

assert.deepEqual(
  extractSetArray(chromiumContent, "HOSTILE_HOSTS"),
  extractSetArray(firefoxContent, "HOSTILE_HOSTS"),
  "Chromium and Firefox content-script hostile-host policy must stay identical"
);

assert.deepEqual(
  messageTypes(chromiumBackground),
  messageTypes(firefoxBackground),
  "Chromium and Firefox runtime message contracts must stay aligned"
);

assert.deepEqual(
  emittedEvents(chromiumContent),
  emittedEvents(firefoxContent),
  "Chromium and Firefox blocked-event telemetry names must stay aligned"
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
