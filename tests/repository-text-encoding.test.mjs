import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

assert.ok(tracked.length > 0, "at least one tracked path must be discovered");

const textExtensions = new Set([
  ".cjs", ".css", ".env", ".html", ".js", ".json", ".jsx", ".md", ".mjs",
  ".py", ".rb", ".sh", ".ts", ".tsx", ".txt", ".yaml", ".yml"
]);
const textBasenames = new Set([
  ".dockerignore", ".editorconfig", ".gitattributes", ".gitignore",
  "LICENSE", "README"
]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const unsafeFormatCharacter = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
let checked = 0;

assert.match("\u202e", unsafeFormatCharacter, "bidi-override self-test must be rejected");
assert.match("\u200b", unsafeFormatCharacter, "zero-width self-test must be rejected");
assert.doesNotMatch("plain text", unsafeFormatCharacter, "ordinary text must remain allowed");

function hasShebang(file) {
  const bytes = readFileSync(file);
  return bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21;
}

function isDockerfilePath(file) {
  const base = path.basename(file).toLowerCase();
  return base === "dockerfile" || base.startsWith("dockerfile.");
}

const envTemplateSuffixes = [
  ".env.example",
  ".env.sample",
  ".env.template"
];

function isEnvironmentTemplatePath(file) {
  const base = path.basename(file).toLowerCase();
  return envTemplateSuffixes.some((suffix) => base.endsWith(suffix));
}

function isTextContractPath(file) {
  const base = path.basename(file);
  if (textBasenames.has(base)) return true;
  if (isDockerfilePath(file)) return true;
  if (isEnvironmentTemplatePath(file)) return true;
  if (textExtensions.has(path.extname(base).toLowerCase())) return true;
  return hasShebang(file);
}

assert.equal(isDockerfilePath("Dockerfile"), true, "text contract must include canonical Dockerfiles");
assert.equal(isDockerfilePath("dockerfile"), true, "text contract must include lowercase Dockerfile variants");
assert.equal(isDockerfilePath("images/DOCKERFILE.prod"), true, "text contract must include suffixed case variants");
assert.equal(isDockerfilePath("images/MyDockerfile"), false, "text contract must reject unrelated basenames");
assert.equal(isEnvironmentTemplatePath(".env.example"), true, "text contract must include .env.example");
assert.equal(isEnvironmentTemplatePath(".ENV.EXAMPLE"), true, "text contract must casefold env example names");
assert.equal(isEnvironmentTemplatePath("service.env.sample"), true, "text contract must include .env.sample templates");
assert.equal(isEnvironmentTemplatePath("service.ENV.TEMPLATE"), true, "text contract must include .env.template case variants");
assert.equal(isEnvironmentTemplatePath(".env.local"), false, "text contract must not classify local env state as a template");

const extensionlessShebangs = tracked
  .filter((file) => !path.basename(file).includes("."))
  .filter(hasShebang);
assert.ok(
  extensionlessShebangs.length > 0,
  "at least one extensionless shebang script must exercise the text contract"
);

for (const file of tracked.filter(isTextContractPath)) {
  const bytes = readFileSync(file);
  let text;
  try {
    text = decoder.decode(bytes);
  } catch (error) {
    assert.fail(`tracked text file is not valid UTF-8: ${file} (${error.message})`);
  }

  assert.ok(
    !bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    `tracked text file must not contain a UTF-8 BOM: ${file}`
  );
  assert.ok(!text.includes("\u0000"), `tracked text file contains a NUL byte: ${file}`);
  assert.ok(!text.includes("\r"), `tracked text file must use LF line endings: ${file}`);
  if (bytes.length > 0) {
    assert.equal(
      bytes[bytes.length - 1],
      0x0a,
      `tracked text file must end with a final LF newline: ${file}`
    );
  }

  if (path.extname(file).toLowerCase() !== ".md") {
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      assert.doesNotMatch(
        lines[index],
        /[ \t]+$/u,
        `tracked text file contains trailing horizontal whitespace: ${file}:${index + 1}`
      );
    }
  }

  const unsafeControl = text.match(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
  assert.equal(
    unsafeControl,
    null,
    `tracked text file contains an unsafe control character: ${file}`
  );
  assert.doesNotMatch(
    text,
    unsafeFormatCharacter,
    `tracked text file contains an unsafe invisible/bidi format character: ${file}`
  );
  checked += 1;
}

assert.ok(checked > 0, "at least one tracked text file must be validated");

const attributes = readFileSync(".gitattributes", "utf8");
assert.match(
  attributes,
  /^\*\s+text=auto\s+eol=lf\s*$/m,
  ".gitattributes must normalize automatically detected text files to LF"
);

console.log(
  `repository text encoding, line-ending, whitespace, control-character, and invisible-format contract passed for ${checked} tracked text files`
);
