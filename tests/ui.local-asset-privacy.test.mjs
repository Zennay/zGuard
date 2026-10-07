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

const uiRoots = [
  "chromium/",
  "firefox/",
  "zbrowse/gateway/public/",
  "zbrowse/browser/zguard/"
];

function isUiAsset(relative) {
  const normalized = relative.replaceAll("\\", "/");
  const extension = path.extname(normalized).toLowerCase();
  return uiRoots.some((prefix) => normalized.startsWith(prefix)) &&
    (extension === ".html" || extension === ".css");
}

const files = tracked.filter(isUiAsset).sort();
assert.ok(files.length > 0, "repository must contain tracked UI HTML/CSS assets");
assert.equal(isUiAsset("chromium/popup.html"), true, "canonical Chromium UI assets must be discovered");
assert.equal(isUiAsset("firefox/POPUP.CSS"), true, "UI asset discovery must casefold extensions");
assert.equal(isUiAsset("zbrowse/gateway/public/panel.HTML"), true, "future zBrowse public UI assets must be discovered");
assert.equal(isUiAsset("zbrowse/browser/zguard/popup.css"), true, "bundled zGuard UI assets must be covered");
assert.equal(isUiAsset("docs/example.html"), false, "non-UI documentation assets must remain outside this contract");
assert.equal(isUiAsset("chromium/background.js"), false, "non-HTML/CSS UI package files must remain outside this contract");

const remoteUrl = /(?:https?:)?\/\//i;
const nonLocalHtmlUrl = /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i;
const embeddedUrl = /^(?:data|blob):/i;
const cssImport = /@import\s+/i;
const nonLocalCssUrl = /url\(\s*['"]?(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
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
    .replace(/&sol;/gi, "/")
    .replace(/&bsol;/gi, "\\")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n");

  return decoded.replace(/[\t\n\r]/g, "").trimStart();
}

function decodeCssEscapes(value) {
  return value
    .replace(/\\([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?/gi, (match, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint === 0 || codePoint > 0x10ffff) return "\uFFFD";
      return String.fromCodePoint(codePoint);
    })
    .replace(/\\([^\n\r\f0-9a-f])/gi, "$1");
}

assert.match(
  decodeCssEscapes("@\\69mport url(local.css)"),
  cssImport,
  "escaped CSS @import must normalize before privacy checks"
);
assert.match(
  decodeCssEscapes("body{background:url(https:\\00002f\\00002fcdn.example/x.png)}"),
  nonLocalCssUrl,
  "escaped remote CSS url() must normalize before privacy checks"
);
assert.match(
  decodeCssEscapes("body{background:url(https:cdn.example/x.png)}"),
  nonLocalCssUrl,
  "special-scheme CSS url() must be treated as non-local even without //"
);
assert.match(
  decodeCssEscapes("body{background:url(https\\00003acdn.example/x.png)}"),
  nonLocalCssUrl,
  "escaped CSS scheme delimiter must normalize before special-scheme checks"
);
assert.match(
  decodeCssEscapes("body{background:url(data:image/svg+xml;base64,PHN2Zz4=)}"),
  nonLocalCssUrl,
  "data: CSS resources must be rejected as non-local"
);
assert.match(
  decodeCssEscapes("body{background:url(file:///tmp/private.png)}"),
  nonLocalCssUrl,
  "file: CSS resources must be rejected as non-local"
);
assert.match(
  decodeCssEscapes("body{background:url(blob:https://example.test/id)}"),
  nonLocalCssUrl,
  "blob: CSS resources must be rejected as non-local"
);

function assertNoExternalHtmlAssets(relative, content) {
  for (const match of content.matchAll(/<(?:script|link|img|iframe|source|video|audio|track|embed|object|input|image|use)\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);

    for (const attribute of ["src", "href", "poster", "data"]) {
      const value = attrs.get(attribute);
      if (value === undefined) continue;

      const normalized = normalizeHtmlUrl(value);
      assert.doesNotMatch(
        normalized,
        embeddedUrl,
        `${relative}: UI resources must come from tracked/local URLs, not data: or blob: schemes`
      );
      assert.doesNotMatch(
        normalized,
        nonLocalHtmlUrl,
        `${relative}: UI must not load third-party script/style/media assets`
      );
    }

    const srcset = attrs.get("srcset");
    if (srcset !== undefined) {
      const candidates = srcset
        .split(",")
        .map((candidate) => candidate.trim().split(/\s+/, 1)[0])
        .filter(Boolean);

      for (const candidate of candidates) {
        const normalized = normalizeHtmlUrl(candidate);
        assert.doesNotMatch(
          normalized,
          nonLocalHtmlUrl,
          `${relative}: UI srcset must not load third-party media assets`
        );
        assert.doesNotMatch(
          normalized,
          embeddedUrl,
          `${relative}: UI srcset must not embed data: or blob: media`
        );
      }
    }

    if (attrs.has("srcdoc")) {
      assert.fail(
        `${relative}: iframe srcdoc is forbidden; active embedded markup must remain in tracked files`
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
  () => assertNoExternalHtmlAssets("self-test.html", '<img src="https&colon;&sol;&sol;cdn.example/logo.svg">'),
  /must not load third-party/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<source src=&sol;&sol;cdn.example/video.mp4>'),
  /must not load third-party/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<img src="https:cdn.example/logo.svg">'),
  /must not load third-party/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<source src="&bsol;&bsol;cdn.example/video.mp4">'),
  /must not load third-party/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<track src="/&bsol;cdn.example/captions.vtt">'),
  /must not load third-party/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<source src=&#x2f;&#x2f;cdn.example/video.mp4>'),
  /must not load third-party/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<img srcset="/local.png 1x, https&#58;//cdn.example/remote.png 2x">'),
  /srcset must not load third-party/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<video poster=//cdn.example/poster.jpg></video>'),
  /must not load third-party/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<object data="https://cdn.example/widget"></object>'),
  /must not load third-party/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<img src="data:image/svg+xml;base64,PHN2Zz4=">'),
  /must come from tracked\/local URLs/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<object data="blob:https://example.test/id"></object>'),
  /must come from tracked\/local URLs/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<img src="file:///tmp/private.png">'),
  /must not load third-party/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<img src="ftp://cdn.example/logo.png">'),
  /must not load third-party/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<iframe srcdoc="<p>inline</p>"></iframe>'),
  /iframe srcdoc is forbidden/
);
assert.throws(
  () => assertNoExternalHtmlAssets("self-test.html", '<track src="//cdn.example/captions.vtt">'),
  /must not load third-party/
);

for (const relative of files) {
  const absolute = path.join(root, relative);
  assert.ok(fs.existsSync(absolute), `${relative}: expected UI asset is missing`);
  const content = fs.readFileSync(absolute, "utf8");

  if (path.extname(relative).toLowerCase() === ".html") {
    assertNoExternalHtmlAssets(relative, content);
  }
  const normalizedCss = path.extname(relative).toLowerCase() === ".css" ? decodeCssEscapes(content) : content;
  assert.doesNotMatch(
    normalizedCss,
    cssImport,
    `${relative}: CSS @import is forbidden; bundle local styles directly`
  );
  assert.doesNotMatch(
    normalizedCss,
    nonLocalCssUrl,
    `${relative}: remote CSS url() dependencies are forbidden`
  );

  if (path.extname(relative).toLowerCase() === ".css") {
    assert.doesNotMatch(
      normalizedCss,
      remoteUrl,
      `${relative}: stylesheets must remain fully local`
    );
  }
}

console.log("zGuard/zBrowse local UI asset privacy contract passed");
