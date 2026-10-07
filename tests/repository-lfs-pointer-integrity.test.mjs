import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lfsVersion = "version https://git-lfs.github.com/spec/v1";

function isLfsPointer(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== lfsVersion) return false;

  const hasOid = lines.some((line) => /^oid sha256:[0-9a-f]{64}$/.test(line));
  const hasSize = lines.some((line) => /^size [0-9]+$/.test(line));
  return hasOid && hasSize;
}

const fixtureOid = "a".repeat(64);
assert.equal(
  isLfsPointer(`${lfsVersion}\noid sha256:${fixtureOid}\nsize 123\n`),
  true,
  "canonical Git LFS pointer must be detected"
);
assert.equal(
  isLfsPointer(`prefix\n${lfsVersion}\noid sha256:${fixtureOid}\nsize 123\n`),
  false,
  "embedded documentation text must not be classified as a pointer"
);
assert.equal(
  isLfsPointer(`${lfsVersion}\noid sha256:not-a-digest\nsize 123\n`),
  false,
  "malformed pointer-like text must not be treated as a canonical pointer"
);

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean);

assert.ok(tracked.length > 0, "repository must contain tracked files");

const pointers = [];
for (const relative of tracked) {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile()) continue;

  const bytes = fs.readFileSync(absolute);
  if (bytes.length > 4096) continue;

  const text = bytes.toString("utf8");
  if (isLfsPointer(text)) pointers.push(relative);
}

assert.deepEqual(
  pointers,
  [],
  [
    "tracked Git LFS pointer files are not allowed in this repository",
    ...pointers.map((file) => `- ${file}`),
    "Commit the real small asset/source file or add an explicit reviewed artifact delivery mechanism.",
  ].join("\n")
);

console.log(
  `repository Git LFS pointer integrity passed for ${tracked.length} tracked paths`
);
