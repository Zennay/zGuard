import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envText = fs.readFileSync(path.join(root, "zbrowse/.env.example"), "utf8");
const compose = fs.readFileSync(path.join(root, "zbrowse/docker-compose.yml"), "utf8");
const workflow = fs.readFileSync(
  path.join(root, ".github/workflows/zbrowse-env-compose-parity.yml"),
  "utf8"
);

const env = new Map();
for (const [index, rawLine] of envText.split(/\r?\n/).entries()) {
  if (!rawLine) continue;
  assert.ok(!rawLine.startsWith("#"), ".env.example should remain a machine-readable defaults file");
  const separator = rawLine.indexOf("=");
  assert.ok(separator > 0, `line ${index + 1}: expected KEY=value`);
  const key = rawLine.slice(0, separator);
  const value = rawLine.slice(separator + 1);
  assert.match(key, /^[A-Z][A-Z0-9_]*$/, `line ${index + 1}: invalid environment key`);
  assert.ok(!env.has(key), `${key}: duplicate .env.example entry`);
  assert.equal(value, value.trim(), `${key}: example value must be trimmed`);
  assert.ok(value.length > 0, `${key}: example value must not be empty`);
  env.set(key, value);
}

const requiredKeys = [
  "PORT",
  "MAX_SESSIONS",
  "SESSION_TTL_MINUTES",
  "IDLE_TTL_MINUTES",
  "BROWSER_MEMORY_MB",
  "BROWSER_CPU",
  "BROWSER_IMAGE",
  "BROWSER_NETWORK",
  "DOCKER_GID",
  "TRUST_PROXY",
  "START_URL"
];

assert.deepEqual(
  [...env.keys()].sort(),
  [...requiredKeys].sort(),
  ".env.example keys must exactly match the reviewed zBrowse install surface"
);

function composeDefaultsFor(key) {
  const marker = "${" + key + ":-";
  const values = [];
  let offset = 0;

  while (true) {
    const start = compose.indexOf(marker, offset);
    if (start < 0) break;
    const valueStart = start + marker.length;
    const end = compose.indexOf("}", valueStart);
    assert.ok(end > valueStart, `${key}: malformed Compose default expression`);
    values.push(compose.slice(valueStart, end));
    offset = end + 1;
  }

  return values;
}

for (const key of requiredKeys) {
  const defaults = composeDefaultsFor(key);
  assert.ok(defaults.length > 0, `${key}: docker-compose.yml must declare a default`);
  assert.ok(
    defaults.every((value) => value === defaults[0]),
    `${key}: Compose uses conflicting defaults: ${defaults.join(", ")}`
  );
  assert.equal(
    env.get(key),
    defaults[0],
    `${key}: .env.example must match the Compose default`
  );
}

assert.doesNotMatch(
  env.get("BROWSER_IMAGE"),
  /(^|:)latest$/,
  "BROWSER_IMAGE must not use a mutable latest tag"
);
assert.equal(new URL(env.get("START_URL")).protocol, "https:", "START_URL must use HTTPS");

for (const expected of [
  'repository: ${{ github.event.pull_request.head.repo.full_name || github.repository }}',
  'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
  'EXPECTED_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
  'run: test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'
]) {
  assert.ok(
    workflow.includes(expected),
    `env/Compose workflow must retain exact-head checkout proof: ${expected}`
  );
}
assert.ok(
  workflow.includes("persist-credentials: false"),
  "env/Compose checkout must not persist credentials"
);

console.log("zBrowse env/Compose default parity contract passed");
