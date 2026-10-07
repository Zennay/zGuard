import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = execFileSync("git", ["ls-files", "-s", "-z"], {
  cwd: root,
  encoding: "utf8"
});

const entries = raw.split("\0").filter(Boolean).map((entry) => {
  const match = entry.match(/^(\d{6}) ([0-9a-f]{40,64}) (\d+)\t(.+)$/s);
  assert.ok(match, `unexpected git ls-files entry: ${JSON.stringify(entry)}`);
  return { mode: match[1], stage: match[3], file: match[4] };
});

assert.ok(entries.length > 0, "at least one tracked entry must be discovered");

const allowedModes = new Set(["100644", "100755", "120000"]);

function resolveSafeSymlinkTarget(file, target) {
  assert.ok(!path.isAbsolute(target), `tracked symlink must be relative: ${file} -> ${target}`);

  const resolved = path.resolve(root, path.dirname(file), target);
  assert.ok(
    resolved === root || resolved.startsWith(root + path.sep),
    `tracked symlink escapes the repository: ${file} -> ${target}`
  );

  const relative = path.relative(root, resolved);
  assert.ok(
    relative !== ".git" && !relative.startsWith(`.git${path.sep}`),
    `tracked symlink must not target Git metadata: ${file} -> ${target}`
  );

  return resolved;
}

assert.doesNotThrow(() => resolveSafeSymlinkTarget("nested/link", "../target.txt"));
assert.throws(
  () => resolveSafeSymlinkTarget("link", ".git/config"),
  /must not target Git metadata/
);
assert.throws(
  () => resolveSafeSymlinkTarget("nested/link", "../.git/config"),
  /must not target Git metadata/
);
assert.throws(
  () => resolveSafeSymlinkTarget("link", "../outside"),
  /escapes the repository/
);

for (const { mode, stage, file } of entries) {
  assert.equal(stage, "0", `tracked path must not contain unresolved index stages: ${file}`);
  assert.ok(
    allowedModes.has(mode),
    `tracked path uses unsupported/special git mode ${mode}: ${file}`
  );

  if (mode !== "120000") continue;

  const linkPath = path.join(root, file);
  const target = fs.readlinkSync(linkPath);
  const resolved = resolveSafeSymlinkTarget(file, target);

  assert.ok(
    fs.existsSync(resolved),
    `tracked symlink target must exist in the checkout: ${file} -> ${target}`
  );
}

console.log(`repository symlink safety contract passed for ${entries.length} tracked entries`);
