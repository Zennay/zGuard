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

const unsafeScheme = /^(?:javascript|file|data):/i;
const externalScheme = /^(?:https?|mailto):/i;

function assertBalancedCodeFences(file, source) {
  let openFence = null;
  const lines = source.split("\\n");

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const match = lines[index].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;

    const marker = match[1];
    const rest = match[2];
    const markerChar = marker[0];

    if (!openFence) {
      if (markerChar === "`") {
        assert.doesNotMatch(
          rest,
          /`/,
          `${file}:${lineNumber}: backtick fence info strings must not contain backticks`
        );
      }
      openFence = { markerChar, length: marker.length, lineNumber };
      continue;
    }

    const closesCurrent =
      markerChar === openFence.markerChar &&
      marker.length >= openFence.length &&
      rest.trim() === "";

    if (closesCurrent) openFence = null;
  }

  assert.equal(
    openFence,
    null,
    openFence
      ? `${file}:${openFence.lineNumber}: fenced code block is not closed`
      : `${file}: fenced code block integrity failed`
  );
}

for (const file of markdownFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assertBalancedCodeFences(file, source);
  const references = [...source.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
    .map((match) => match[1].replace(/^<|>$/g, ""));

  for (const reference of references) {
    assert.doesNotMatch(reference, unsafeScheme, `${file}: unsafe Markdown link scheme: ${reference}`);

    if (
      externalScheme.test(reference) ||
      reference.startsWith("#") ||
      reference === ""
    ) {
      continue;
    }

    assert.equal(
      reference.startsWith("//"),
      false,
      `${file}: protocol-relative Markdown links are forbidden: ${reference}`
    );
    assert.equal(
      reference.startsWith("/"),
      false,
      `${file}: root-relative Markdown links are not portable: ${reference}`
    );

    const withoutFragment = reference.split("#", 1)[0];
    const withoutQuery = withoutFragment.split("?", 1)[0];
    const decoded = decodeURIComponent(withoutQuery);
    const resolved = path.resolve(root, path.dirname(file), decoded);

    assert.ok(
      resolved === root || resolved.startsWith(root + path.sep),
      `${file}: local Markdown link escapes the repository: ${reference}`
    );
    assert.ok(
      fs.existsSync(resolved),
      `${file}: local Markdown link target does not exist: ${reference}`
    );
  }
}

console.log(`Markdown link and code-fence integrity passed for ${markdownFiles.length} tracked files`);
