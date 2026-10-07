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

const executable = entries.filter(({ mode, stage }) => mode === "100755" && stage === "0");

for (const { file } of executable) {
  const bytes = fs.readFileSync(path.join(root, file));
  assert.ok(
    bytes.subarray(0, 2).equals(Buffer.from("#!")),
    `tracked executable must declare an interpreter with a shebang: ${file}`
  );
}

console.log(`repository executable-mode contract passed for ${executable.length} executable files`);
