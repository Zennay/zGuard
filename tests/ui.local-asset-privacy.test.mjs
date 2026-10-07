import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = [
  "chromium/popup.html",
  "chromium/popup.css",
  "firefox/popup.html",
  "firefox/popup.css",
  "zbrowse/gateway/public/index.html",
  "zbrowse/gateway/public/styles.css"
];

const remoteUrl = /(?:https?:)?\/\//i;
const cssImport = /@import\s+/i;
const remoteCssUrl = /url\(\s*['"]?(?:https?:)?\/\//i;
function attributes(tagSource) {
  const opening = tagSource.match(/^<[a-z][\w:-]*\b/i);
  assert.ok(opening, `opening tag could not be parsed: ${tagSource}`);
  const body = tagSource.slice(opening[0].length).replace(/\/?>$/, "");
  const attrs = new Map();
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;

  for (const match of body.matchAll(pattern)) {
    attrs.set(
      match[1].toLowerCase(),
      match[2] ?? match[3] ?? match[4] ?? ""
    );
  }
  return attrs;
}

function normalizeHtmlUrl(value) {
  const decoded = value
    .replace(/&#x([0-9a-f]+);?/gi, (match, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&#([0-9]+);?/g, (match, decimal) => {
      const codePoint = Number.parseInt(decimal, 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n");

  return decoded.replace(/[\t\n\r]/g, "").trimStart();
}

function assertNoExternalHtmlAssets(relative, content) {
  for (const match of content.matchAll(/<(?:script|link|img|iframe|source)\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);

    for (const attribute of ["src", "href"]) {
      const value = attrs.get(attribute);
      if (value === undefined) continue;

      assert.doesNotMatch(
        normalizeHtmlUrl(value),
        /^(?:https?:)?\/\//i,
        `${relative}: UI must not load third-party script/style/media assets`
      );
    }
  }
}

assert.doesNotThrow(() =>
  assertNoExternalHtmlAssets("self-test.html", '<img src=/assets/logo.svg>')
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<img src=https://cdn.example/logo.svg>'),
  /must not load third-party/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<iframe src="https&#58;//example.test/embed">'),
  /must not load third-party/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<source src=&#x2f;&#x2f;cdn.example/video.mp4>'),
  /must not load third-party/
);

for (const relative of files) {
  const absolute = path.join(root, relative);
  assert.ok(fs.existsSync(absolute), `${relative}: expected UI asset is missing`);
  const content = fs.readFileSync(absolute, "utf8");

  if (relative.endsWith(".html")) {
    assertNoExternalHtmlAssets(relative, content);
  }
  assert.doesNotMatch(
    content,
    cssImport,
    `${relative}: CSS @import is forbidden; bundle local styles directly`
  );
  assert.doesNotMatch(
    content,
    remoteCssUrl,
    `${relative}: remote CSS url() dependencies are forbidden`
  );

  if (relative.endsWith(".css")) {
    assert.doesNotMatch(
      content,
      remoteUrl,
      `${relative}: stylesheets must remain fully local`
    );
  }
}

console.log("zGuard/zBrowse local UI asset privacy contract passed");
