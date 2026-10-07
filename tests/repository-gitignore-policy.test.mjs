import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, ".gitignore"), "utf8");

const allowedRules = new Set([
  ".DS_Store",
  "*.zip",
  "node_modules/",
  ".env",
  ".env.local",
  ".env.*.local",
]);

function activeRules(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function isIgnored(candidate) {
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--quiet", "--", candidate],
    { cwd: root, encoding: "utf8" }
  );

  assert.ok(
    result.status === 0 || result.status === 1,
    `git check-ignore failed for ${candidate}: ${result.stderr || result.stdout}`
  );
  return result.status === 0;
}

const rules = activeRules(source);
assert.equal(
  new Set(rules).size,
  rules.length,
  ".gitignore must not contain duplicate active rules"
);
assert.deepEqual(
  [...rules].sort(),
  [...allowedRules].sort(),
  ".gitignore policy changes must be explicitly reviewed in the integrity contract"
);
assert.equal(
  rules.some((rule) => rule.startsWith("!")),
  false,
  ".gitignore must not use negation rules that can silently reopen ignored local state"
);

for (const candidate of [
  ".DS_Store",
  "tmp/archive.zip",
  "node_modules/package/index.js",
  "zbrowse/gateway/node_modules/cache.bin",
  ".env",
  "zbrowse/.env",
  ".env.local",
  "zbrowse/.env.development.local",
]) {
  assert.equal(
    isIgnored(candidate),
    true,
    `local/generated path must remain ignored: ${candidate}`
  );
}

for (const candidate of [
  "future.js",
  "future.py",
  "README.md",
  "tests/future.test.mjs",
  ".github/workflows/future.yml",
  "zbrowse/gateway/future.js",
  "zbrowse/browser/Dockerfile",
  "zbrowse/.env.example",
]) {
  assert.equal(
    isIgnored(candidate),
    false,
    `representative source/config path must remain visible to git: ${candidate}`
  );
}

console.log(
  `repository gitignore policy passed for ${rules.length} reviewed rules`
);
