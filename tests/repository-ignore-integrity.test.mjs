import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredTracked = execFileSync(
  "git",
  ["ls-files", "-ci", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" }
).split("\0").filter(Boolean).sort();

assert.deepEqual(
  ignoredTracked,
  [],
  `tracked files must not violate repository ignore rules:\n${ignoredTracked.join("\n")}`
);

console.log("repository ignore-integrity contract passed");
