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

const isCssPath = (file) => path.extname(file).toLowerCase() === '.css';
const cssFiles = tracked.filter(isCssPath).sort();
assert.ok(cssFiles.length > 0, "repository must contain tracked CSS files");
assert.equal(isCssPath('styles.CSS'), true, 'CSS discovery must be case-insensitive');
assert.equal(isCssPath('styles.CsS'), true, 'CSS discovery must accept mixed-case extensions');
assert.equal(isCssPath('styles.css.txt'), false, 'CSS discovery must reject non-CSS suffixes');

const opening = new Map([["{", "}"], ["[", "]"], ["(", ")"]]);
const closing = new Map([["}", "{"], ["]", "["], [")", "("]]);

function validateCssStructure(source, label) {
  const stack = [];
  let quote = null;
  let inComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inComment) {
      if (char === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }

    if (quote !== null) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === "\n" || char === "\r" || char === "\f") {
        throw new Error(`${label}: unescaped newline in CSS string at offset ${index}`);
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      inComment = true;
      index += 1;
      continue;
    }

    if (char === "*" && next === "/") {
      throw new Error(`${label}: stray CSS comment terminator at offset ${index}`);
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "\\") {
      index += 1;
      continue;
    }

    if (opening.has(char)) {
      stack.push({ char, index });
      continue;
    }

    if (closing.has(char)) {
      const top = stack.pop();
      if (!top || top.char !== closing.get(char)) {
        throw new Error(`${label}: unmatched "${char}" at offset ${index}`);
      }
    }
  }

  if (inComment) {
    throw new Error(`${label}: unterminated CSS comment`);
  }
  if (quote !== null) {
    throw new Error(`${label}: unterminated ${quote} string`);
  }
  if (stack.length > 0) {
    const top = stack.at(-1);
    throw new Error(
      `${label}: unclosed "${top.char}" from offset ${top.index}; expected "${opening.get(top.char)}"`
    );
  }
}

// Keep the lexical guard itself honest around strings, comments, escapes and nested at-rules.
assert.doesNotThrow(() => validateCssStructure(
  '@media screen and (min-width: 1px) { .x[data-label="]"] { content: "}"; width: calc(100% - 1px); } }',
  "self-test valid"
));
assert.doesNotThrow(() => validateCssStructure(".x { content: \"first" + "\\" + "\n" + "second\"; }", "self-test escaped newline"));
assert.throws(() => validateCssStructure(".x { color: red; ", "self-test brace"), /unclosed/);
assert.throws(() => validateCssStructure(".x { color: \"red; }", "self-test string"), /unterminated/);
assert.throws(() => validateCssStructure(".x { content: \"first\nsecond\"; }", "self-test raw newline"), /unescaped newline/);
assert.throws(() => validateCssStructure(".x { /* open", "self-test comment"), /unterminated/);
assert.throws(() => validateCssStructure(".x { color: red; }}", "self-test close"), /unmatched/);

for (const file of cssFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  validateCssStructure(source, file);
}

console.log(`CSS structure integrity passed for ${cssFiles.length} tracked files`);
