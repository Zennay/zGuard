import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const attributesPath = path.join(root, ".gitattributes");
const source = fs.readFileSync(attributesPath, "utf8");

function attributeName(token) {
  return token.replace(/^[-!]/, "").split("=", 1)[0].toLowerCase();
}

const forbiddenAttributes = new Set([
  "diff",
  "filter",
  "ident",
  "merge",
  "working-tree-encoding",
]);

function hasForbiddenAttribute(token) {
  return forbiddenAttributes.has(attributeName(token));
}

for (const token of [
  "filter=clean",
  "-diff",
  "merge=ours",
  "working-tree-encoding=UTF-16",
  "!ident",
]) {
  assert.equal(
    hasForbiddenAttribute(token),
    true,
    `gitattributes self-test must reject ${token}`
  );
}

for (const token of ["text=auto", "eol=lf", "binary"]) {
  assert.equal(
    hasForbiddenAttribute(token),
    false,
    `gitattributes self-test must allow ordinary attribute token ${token}`
  );
}

const lines = source
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

assert.ok(lines.length > 0, ".gitattributes must contain at least one active rule");
assert.ok(
  lines.includes("* text=auto eol=lf"),
  ".gitattributes must keep the universal LF normalization baseline"
);

for (const line of lines) {
  const tokens = line.split(/\s+/);
  assert.ok(tokens.length >= 2, `.gitattributes rule must declare attributes: ${line}`);

  const pattern = tokens[0];
  const attributes = tokens.slice(1);

  assert.ok(
    !pattern.startsWith("[attr]"),
    `.gitattributes custom macros are not allowed because they can hide repository transforms: ${line}`
  );

  for (const token of attributes) {
    assert.equal(
      hasForbiddenAttribute(token),
      false,
      `.gitattributes must not enable repository-specific Git transforms/drivers (${attributeName(token)}): ${line}`
    );

    if (attributeName(token) === "eol") {
      assert.equal(
        token.toLowerCase(),
        "eol=lf",
        `.gitattributes must not request non-LF working-tree line endings: ${line}`
      );
    }
  }
}

console.log(
  `repository .gitattributes integrity contract passed for ${lines.length} active rules`
);
