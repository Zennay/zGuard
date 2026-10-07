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
const embeddedUrl = /^(?:data|blob):/i;
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
    .replace(/&sol;/gi, "/")
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
  remoteCssUrl,
  "escaped remote CSS url() must normalize before privacy checks"
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
        /^(?:https?:)?\/\//i,
        `${relative}: UI must not load third-party script/style/media assets`
      );
      assert.doesNotMatch(
        normalized,
        embeddedUrl,
        `${relative}: UI resources must come from tracked/local URLs, not data: or blob: schemes`
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
          /^(?:https?:)?\/\//i,
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

  if (relative.endsWith(".html")) {
    assertNoExternalHtmlAssets(relative, content);
  }
  const normalizedCss = relative.endsWith(".css") ? decodeCssEscapes(content) : content;
  assert.doesNotMatch(
    normalizedCss,
    cssImport,
    `${relative}: CSS @import is forbidden; bundle local styles directly`
  );
  assert.doesNotMatch(
    normalizedCss,
    remoteCssUrl,
    `${relative}: remote CSS url() dependencies are forbidden`
  );

  if (relative.endsWith(".css")) {
    assert.doesNotMatch(
      normalizedCss,
      remoteUrl,
      `${relative}: stylesheets must remain fully local`
    );
  }
}

console.log("zGuard/zBrowse local UI asset privacy contract passed");
