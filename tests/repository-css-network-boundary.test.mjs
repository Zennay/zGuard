import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root, encoding: "utf8"
}).split("\0").filter(Boolean);
const cssFiles = tracked.filter((file) => path.extname(file).toLowerCase() === ".css").sort();
for (const required of [
  "chromium/popup.css", "firefox/popup.css",
  "zbrowse/browser/zguard/popup.css", "zbrowse/gateway/public/styles.css"
]) {
  assert.ok(cssFiles.includes(required), "CSS coverage missing " + required);
}

const blockedRules = new Set(["import", "namespace", "font-face"]);
const blockedFunctions = new Set(["url", "image-set", "-webkit-image-set", "expression"]);

function identifier(text, start) {
  let value = "";
  let index = start;
  while (index < text.length) {
    if (/[a-z0-9_-]/i.test(text[index])) {
      value += text[index++];
    } else if (text[index] === "\\") {
      index++;
      const hex = /^[0-9a-f]{1,6}/i.exec(text.slice(index));
      if (hex) {
        const cp = parseInt(hex[0], 16);
        value += String.fromCodePoint(cp < 1 || cp > 0x10ffff ||
          (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp);
        index += hex[0].length;
        if (/\s/.test(text[index] ?? "")) index++;
      } else if (index < text.length) {
        value += text[index++];
      }
    } else {
      break;
    }
  }
  return {value: value.toLowerCase(), end: index};
}

function validate(text, label) {
  for (let i = 0; i < text.length;) {
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      assert.notEqual(end, -1, label + ": unterminated comment");
      i = end + 2;
      continue;
    }
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i++];
      let closed = false;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
        } else if (text[i++] === quote) {
          closed = true;
          break;
        }
      }
      assert.ok(closed, label + ": unterminated string");
      continue;
    }
    const at = text[i] === "@";
    const start = at ? i + 1 : i;
    if (/[a-z_-]/i.test(text[start] ?? "") || text[start] === "\\") {
      const token = identifier(text, start);
      if (token.end > start) {
        if (at && blockedRules.has(token.value)) {
          assert.fail(label + ": forbidden @" + token.value);
        }
        if (!at && blockedFunctions.has(token.value) &&
            /^\s*\(/.test(text.slice(token.end))) {
          assert.fail(label + ": forbidden " + token.value + "() function");
        }
        i = token.end;
        continue;
      }
    }
    i++;
  }
}

const slash = String.fromCharCode(92);
for (const safe of [
  ".x { color: var(--accent); }",
  '.x::before { content: "url(https://remote.test) @import"; }',
  "/* @import url(https://remote.test) */ .x { color: red; }",
  "@media (prefers-reduced-motion: reduce) { .x { transition: none; } }"
]) {
  assert.doesNotThrow(() => validate(safe, "positive"));
}
for (const unsafe of [
  '@import "https://remote.test/a.css";',
  '@IMPORT "local.css";',
  "@i" + slash + "6d port " + slash + "75rl(https://remote.test/a.css);",
  '.x { background: URL("https://remote.test/pixel"); }',
  ".x { cursor: url(local.cur), auto; }",
  ".x { background: u" + slash + "72 l(https://remote.test/pixel); }",
  ".x { background: " + slash + "000075rl(https://remote.test/pixel); }",
  '.x { background: image-set("https://remote.test/1" 1x); }',
  '.x { background: -webkit-image-set("https://remote.test/1" 1x); }',
  "@font-face { font-family: test; src: local(test); }",
  '@namespace svg "https://example.test/svg";',
  ".x { width: expression(alert(1)); }"
]) {
  assert.throws(() => validate(unsafe, "negative"), /forbidden/, unsafe);
}

for (const file of cssFiles) {
  validate(fs.readFileSync(path.join(root, file), "utf8"), file);
}

const workflow = fs.readFileSync(path.join(root,
  ".github/workflows/repository-css-network-boundary.yml"), "utf8");
for (const token of [
  "pull_request:", "push:", "workflow_dispatch:",
  "runs-on: ubuntu-latest", "timeout-minutes: 5", "contents: read",
  "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
  "persist-credentials: false", "git rev-parse HEAD",
  "repository:", "ref:", "EXPECTED_SHA:",
  "node tests/repository-css-network-boundary.test.mjs"
]) {
  assert.ok(workflow.includes(token), "CSS CI workflow missing " + token);
}
assert.doesNotMatch(workflow, /^\s+paths:\s*$/m, "CSS QA cannot skip path changes");
console.log("CSS network side-effect boundary passed for " + cssFiles.length + " tracked CSS files");
