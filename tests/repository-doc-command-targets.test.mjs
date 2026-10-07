import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
      const escaped = fence.char === "`" ? "`" : "~";
      const closing = new RegExp(`^\\s{0,3}${escaped}{${fence.length},}\\s*$`);
      if (closing.test(line)) {
        if (shellLanguages.has(fence.language)) {
          blocks.push({ body: fence.body, line: fence.line });
        }
        fence = null;
      } else {
        fence.body.push(line);
      }
      continue;
    }

    const opening = line.match(/^\s{0,3}((?:`{3,})|(?:~{3,}))\s*([^\s]*)?.*$/);
    if (!opening) continue;

    fence = {
      char: opening[1][0],
      length: opening[1].length,
      language: (opening[2] ?? "").toLowerCase(),
      line: index + 1,
      body: []
    };
  }

  assert.equal(fence, null, `${label}: unterminated fenced code block`);
  return blocks;
}

function tokens(line) {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter(Boolean);
}

function assertLocalTarget(markdownFile, target, detail) {
  assert.ok(target, `${markdownFile}: ${detail} must include a local target`);
  assert.ok(!target.startsWith("-"), `${markdownFile}: ${detail} target cannot be an option: ${target}`);
  assert.doesNotMatch(target, /^(?:[a-z]+:)?\/\//i, `${markdownFile}: ${detail} must use a local path`);
  assert.equal(path.isAbsolute(target), false, `${markdownFile}: ${detail} must not use an absolute path`);
  assert.equal(target.includes("$"), false, `${markdownFile}: ${detail} must not use an unresolved variable path`);

  const resolved = path.resolve(root, path.dirname(markdownFile), target);
  assert.ok(
    resolved === root || resolved.startsWith(root + path.sep),
    `${markdownFile}: ${detail} target escapes repository: ${target}`
  );
  assert.ok(fs.existsSync(resolved), `${markdownFile}: ${detail} target does not exist: ${target}`);
}

function validateCommandLine(markdownFile, line, lineNumber) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return 0;

  const argv = tokens(trimmed);
  if (argv.length === 0) return 0;

  const label = `shell block line ${lineNumber}`;

  if (argv[0] === "node") {
    if (argv.some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg))) return 0;
    const target = argv.find((arg, index) => index > 0 && !arg.startsWith("-"));
    assertLocalTarget(markdownFile, target, `${label} node`);
    return 1;
  }

  if (argv[0] === "bash") {
    if (argv.some((arg) => ["-c", "--command"].includes(arg))) return 0;
    const target = argv.find((arg, index) => index > 0 && !arg.startsWith("-"));
    assertLocalTarget(markdownFile, target, `${label} bash`);
    return 1;
  }

  if (argv[0] === "cp") {
    const operands = argv.slice(1).filter((arg) => !arg.startsWith("-"));
    assert.ok(operands.length >= 2, `${markdownFile}: ${label} cp must have source and destination`);
    for (const source of operands.slice(0, -1)) {
      assertLocalTarget(markdownFile, source, `${label} cp source`);
    }
    return operands.length - 1;
  }

  if (argv[0] === "docker" && argv[1] === "build") {
    const operands = argv.slice(2).filter((arg) => !arg.startsWith("-"));
    assert.ok(operands.length > 0, `${markdownFile}: ${label} docker build must have a context`);
    assertLocalTarget(markdownFile, operands.at(-1), `${label} docker build context`);
    return 1;
  }

  return 0;
}

const selfRoot = "docs/guide.md";
assert.deepEqual(tokens('node "tests/example.js"'), ["node", "tests/example.js"]);
assert.equal(validateCommandLine("README.md", "node tests/smoke.test.js", 1), 1);
assert.equal(validateCommandLine("README.md", 'node -e "console.log(1)"', 2), 0);
assert.equal(validateCommandLine("README.md", 'bash -c "echo ok"', 3), 0);
assert.throws(
  () => assertLocalTarget(selfRoot, "../definitely-missing-file", "self-test"),
  /target does not exist/
);
assert.throws(
  () => assertLocalTarget(selfRoot, "../../../outside-repository", "self-test"),
  /escapes repository/
);

let checked = 0;
for (const file of markdownFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const block of shellBlocks(source, file)) {
    for (let offset = 0; offset < block.body.length; offset += 1) {
      checked += validateCommandLine(file, block.body[offset], block.line + offset + 1);
    }
  }
}

assert.ok(checked > 0, "repository documentation must contain at least one local command target");
console.log(`Documentation command-target integrity passed for ${checked} local targets`);
