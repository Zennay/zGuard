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
const externalTag = /<(?:script|link|img|iframe|source)\b[^>]*(?:src|href)=['"](?:https?:)?\/\//i;

for (const relative of files) {
  const absolute = path.join(root, relative);
  assert.ok(fs.existsSync(absolute), `${relative}: expected UI asset is missing`);
  const content = fs.readFileSync(absolute, "utf8");

  assert.doesNotMatch(
    content,
    externalTag,
    `${relative}: UI must not load third-party script/style/media assets`
  );
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
