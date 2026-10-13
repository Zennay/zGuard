import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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

function resolveSafeSymlinkTarget(file, target, checkoutRoot = root) {
  assert.ok(!path.isAbsolute(target), `tracked symlink must be relative: ${file} -> ${target}`);

  const resolved = path.resolve(checkoutRoot, path.dirname(file), target);
  assert.ok(
    resolved === checkoutRoot || resolved.startsWith(checkoutRoot + path.sep),
    `tracked symlink escapes the repository: ${file} -> ${target}`
  );

  const relative = path.relative(checkoutRoot, resolved);
  assert.ok(
    relative !== ".git" && !relative.startsWith(`.git${path.sep}`),
    `tracked symlink must not target Git metadata: ${file} -> ${target}`
  );

  return resolved;
}

// A lexical target inside the checkout is not enough: an intermediate symlink
// may redirect to ignored/untracked content, .git metadata, or outside the repo.
function validateResolvedSymlink(file, checkoutRoot, trackedRegularFiles) {
  const linkPath = path.join(checkoutRoot, file);
  const target = fs.readlinkSync(linkPath);
  resolveSafeSymlinkTarget(file, target, checkoutRoot);

  const canonicalRoot = fs.realpathSync.native(checkoutRoot);
  let canonicalTarget;
  try {
    canonicalTarget = fs.realpathSync.native(linkPath);
  } catch (error) {
    assert.fail(`tracked symlink must resolve to an existing target: ${file} -> ${target} (${error.code})`);
  }

  assert.ok(
    canonicalTarget.startsWith(canonicalRoot + path.sep),
    `tracked symlink chain escapes checkout: ${file} -> ${target}`
  );
  const relative = path.relative(canonicalRoot, canonicalTarget);
  assert.ok(
    !relative.split(path.sep).includes(".git"),
    `tracked symlink chain reaches Git metadata: ${file} -> ${target}`
  );
  assert.ok(
    fs.statSync(canonicalTarget).isFile(),
    `tracked symlink must resolve to a regular file: ${file} -> ${target}`
  );
  assert.ok(
    trackedRegularFiles.has(relative.split(path.sep).join("/")),
    `tracked symlink must resolve to a tracked regular file: ${file} -> ${target}`
  );
}

// Exercise the *filesystem resolution*, not only the string parser. The real
// repository currently has no symlinks, so fixtures must prove negative cases.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zguard-symlink-"));
try {
  const fixtureRoot = path.join(sandbox, "checkout");
  fs.mkdirSync(path.join(fixtureRoot, "nested"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, ".git"));
  fs.writeFileSync(path.join(fixtureRoot, "tracked.txt"), "tracked\n");
  fs.writeFileSync(path.join(fixtureRoot, "untracked.txt"), "not in git\n");
  fs.writeFileSync(path.join(fixtureRoot, ".git", "config"), "private\n");
  fs.writeFileSync(path.join(sandbox, "outside.txt"), "outside\n");

  fs.symlinkSync("tracked.txt", path.join(fixtureRoot, "safe"));
  fs.symlinkSync("nested/external", path.join(fixtureRoot, "escape"));
  fs.symlinkSync("../../outside.txt", path.join(fixtureRoot, "nested", "external"));
  fs.symlinkSync(".git/config", path.join(fixtureRoot, "metadata"));
  fs.symlinkSync("metadata", path.join(fixtureRoot, "metadata-alias"));
  fs.symlinkSync("untracked.txt", path.join(fixtureRoot, "untracked"));
  fs.symlinkSync("missing.txt", path.join(fixtureRoot, "dangling"));
  fs.symlinkSync(".", path.join(fixtureRoot, "directory"));

  const trackedFixture = new Set(["tracked.txt"]);
  assert.doesNotThrow(() => validateResolvedSymlink("safe", fixtureRoot, trackedFixture));
  assert.throws(
    () => validateResolvedSymlink("escape", fixtureRoot, trackedFixture),
    /symlink chain escapes checkout/
  );
  assert.throws(
    () => validateResolvedSymlink("metadata-alias", fixtureRoot, trackedFixture),
    /symlink chain reaches Git metadata/
  );
  assert.throws(
    () => validateResolvedSymlink("untracked", fixtureRoot, trackedFixture),
    /tracked regular file/
  );
  assert.throws(
    () => validateResolvedSymlink("dangling", fixtureRoot, trackedFixture),
    /existing target/
  );
  assert.throws(
    () => validateResolvedSymlink("directory", fixtureRoot, trackedFixture),
    /regular file/
  );
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
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

const trackedRegularFiles = new Set(
  entries.filter(({ mode }) => mode === "100644" || mode === "100755").map(({ file }) => file)
);

for (const { mode, stage, file } of entries) {
  assert.equal(stage, "0", `tracked path must not contain unresolved index stages: ${file}`);
  assert.ok(
    allowedModes.has(mode),
    `tracked path uses unsupported/special git mode ${mode}: ${file}`
  );

  if (mode !== "120000") continue;

  validateResolvedSymlink(file, root, trackedRegularFiles);
}

console.log(`repository symlink safety contract passed for ${entries.length} tracked entries`);
