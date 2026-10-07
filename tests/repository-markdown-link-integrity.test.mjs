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

function normalizeMarkdownUrl(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (match, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&#([0-9]+);?/g, (match, decimal) => {
      const codePoint = Number.parseInt(decimal, 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&colon;/gi, ":")
    .replace(/&sol;/gi, "/")
    .replace(/&bsol;/gi, "\\")
    .replace(/\\:/g, ":")
    .trimStart();
}

assert.equal(normalizeMarkdownUrl("javascript&colon;alert(1)"), "javascript:alert(1)");
assert.equal(normalizeMarkdownUrl("javascript&#58;alert(1)"), "javascript:alert(1)");
assert.equal(normalizeMarkdownUrl("javascript\\:alert(1)"), "javascript:alert(1)");
assert.equal(normalizeMarkdownUrl("&sol;&sol;example.test/path"), "//example.test/path");

function assertBalancedCodeFences(file, source) {
  let openFence = null;
  const lines = source.split("\n");

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

function markdownHeadingAnchors(source) {
  const anchors = new Set();
  const counts = new Map();
  let openFence = null;

  for (const line of source.split("\n")) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[1];
      const markerChar = marker[0];
      if (!openFence) {
        openFence = { markerChar, length: marker.length };
      } else if (
        markerChar === openFence.markerChar &&
        marker.length >= openFence.length &&
        fence[2].trim() === ""
      ) {
        openFence = null;
      }
      continue;
    }
    if (openFence) continue;

    const heading = line.match(/^ {0,3}#{1,6}(?:[ \t]+|$)(.*)$/);
    if (!heading) continue;

    const title = heading[1]
      .replace(/[ \t]+#+[ \t]*$/, "")
      .replace(/<[^>]*>/g, "")
      .replace(/[`*_~]/g, "")
      .trim()
      .toLowerCase();
    const base = title
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-");
    if (!base) continue;

    const duplicateIndex = counts.get(base) ?? 0;
    const anchor = duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`;
    counts.set(base, duplicateIndex + 1);
    anchors.add(anchor);
  }

  return anchors;
}

function assertMarkdownFragment(file, source, fragment, reference) {
  let decoded;
  assert.doesNotThrow(
    () => {
      decoded = decodeURIComponent(fragment);
    },
    `${file}: Markdown fragment must be valid percent-encoding: ${reference}`
  );
  assert.ok(
    decoded && markdownHeadingAnchors(source).has(decoded),
    `${file}: Markdown fragment target does not exist: ${reference}`
  );
}

const selfTestAnchors = markdownHeadingAnchors(
  "# Intro\n\n## Details\n\n## Details\n\n```md\n## Ignored\n```\n"
);
assert.deepEqual([...selfTestAnchors], ["intro", "details", "details-1"]);
assert.doesNotThrow(() =>
  assertMarkdownFragment("self-test.md", "# Intro\n", "intro", "#intro")
);
assert.throws(
  () => assertMarkdownFragment("self-test.md", "# Intro\n", "missing", "#missing"),
  /fragment target does not exist/
);

for (const file of markdownFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assertBalancedCodeFences(file, source);
  const references = [...source.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
    .map((match) => match[1].replace(/^<|>$/g, ""));

  for (const reference of references) {
    const normalizedReference = normalizeMarkdownUrl(reference);
    assert.doesNotMatch(
      normalizedReference,
      unsafeScheme,
      `${file}: unsafe Markdown link scheme: ${reference}`
    );

    if (externalScheme.test(normalizedReference) || normalizedReference === "") {
      continue;
    }

    if (normalizedReference.startsWith("#")) {
      assertMarkdownFragment(file, source, reference.slice(1), reference);
      continue;
    }

    assert.equal(
      normalizedReference.startsWith("//"),
      false,
      `${file}: protocol-relative Markdown links are forbidden: ${reference}`
    );
    assert.equal(
      normalizedReference.startsWith("/"),
      false,
      `${file}: root-relative Markdown links are not portable: ${reference}`
    );

    const [targetWithQuery, fragment] = reference.split("#", 2);
    const withoutQuery = targetWithQuery.split("?", 1)[0];
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

    if (fragment && path.extname(resolved).toLowerCase() === ".md") {
      assertMarkdownFragment(
        file,
        fs.readFileSync(resolved, "utf8"),
        fragment,
        reference
      );
    }
  }
}

console.log(`Markdown link and code-fence integrity passed for ${markdownFiles.length} tracked files`);
