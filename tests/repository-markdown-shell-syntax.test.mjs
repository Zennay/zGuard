import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8"
}).split("\0").filter(Boolean);

const markdownFiles = tracked.filter((file) => file.endsWith(".md")).sort();
assert.ok(markdownFiles.length > 0, "repository must contain tracked Markdown files");

const shellLanguages = new Set(["bash", "sh", "shell"]);

function shellBlocks(source, label) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (fence) {
      const closing = new RegExp(`^\\s{0,3}${fence.char === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      if (closing.test(line)) {
        if (shellLanguages.has(fence.language)) {
          blocks.push({
            code: fence.body.join("\n") + "\n",
            line: fence.line
          });
        }
        fence = null;
      } else {
        fence.body.push(line);
      }
      continue;
    }

    const opening = line.match(/^\s{0,3}((?:`{3,})|(?:~{3,}))\s*([^\s]*)?.*$/);
    if (!opening) continue;

    const marker = opening[1];
    fence = {
      char: marker[0],
      length: marker.length,
      language: (opening[2] ?? "").toLowerCase(),
      line: index + 1,
      body: []
    };
  }

  assert.equal(fence, null, `${label}: unterminated fenced code block`);
  return blocks;
}

function assertBashSyntax(code, label) {
  const result = spawnSync("bash", ["-n"], {
    input: code,
    encoding: "utf8"
  });

  assert.equal(
    result.status,
    0,
    `${label}: shell snippet failed bash -n: ${(result.stderr || result.stdout).trim()}`
  );
}

const selfTest = shellBlocks(
  [
    "# Example",
    "",
    "```bash",
    "if true; then",
    "  echo ok",
    "fi",
    "```",
    ""
  ].join("\n"),
  "self-test"
);
assert.equal(selfTest.length, 1);
assert.doesNotThrow(() => assertBashSyntax(selfTest[0].code, "self-test valid"));
assert.throws(
  () => assertBashSyntax("if true; then\n  echo broken\n", "self-test invalid"),
  /failed bash -n/
);

let checked = 0;
for (const file of markdownFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const block of shellBlocks(source, file)) {
    assertBashSyntax(block.code, `${file}:${block.line}`);
    checked += 1;
  }
}

assert.ok(checked > 0, "repository must contain at least one fenced shell snippet");
console.log(`Markdown shell syntax contract passed for ${checked} snippets across ${markdownFiles.length} files`);
