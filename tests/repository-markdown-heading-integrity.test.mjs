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

function assertHeadingHierarchy(file, source) {
  let openFence = null;
  let previousHeading = null;
  const lines = source.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);

    if (fence) {
      const marker = fence[1];
      const rest = fence[2];
      const markerChar = marker[0];

      if (!openFence) {
        openFence = { markerChar, length: marker.length };
        continue;
      }

      if (
        markerChar === openFence.markerChar &&
        marker.length >= openFence.length &&
        rest.trim() === ""
      ) {
        openFence = null;
      }
      continue;
    }

    if (openFence) continue;

    const heading = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
    if (!heading) continue;

    const level = heading[1].length;
    const title = heading[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
    assert.ok(title, `${file}:${lineNumber}: ATX headings must not be empty`);

    if (previousHeading) {
      assert.ok(
        level <= previousHeading.level + 1,
        `${file}:${lineNumber}: heading level jumps from H${previousHeading.level} to H${level} after line ${previousHeading.lineNumber}`
      );
    }

    previousHeading = { level, lineNumber };
  }
}

assertHeadingHierarchy(
  "self-test-valid.md",
  "# Title\n\n## Section\n\n### Detail\n\n## Next\n"
);
assertHeadingHierarchy(
  "self-test-fenced.md",
  "# Title\n\n\`\`\`md\n#### Not a heading here\n\`\`\`\n\n## Section\n"
);
assert.throws(
  () => assertHeadingHierarchy("self-test-jump.md", "# Title\n\n### Skipped level\n"),
  /heading level jumps from H1 to H3/
);
assert.throws(
  () => assertHeadingHierarchy("self-test-empty.md", "# Title\n\n##   \n"),
  /must not be empty/
);

for (const file of markdownFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assertHeadingHierarchy(file, source);
}

console.log(
  `Markdown heading hierarchy passed for ${markdownFiles.length} tracked files`
);
