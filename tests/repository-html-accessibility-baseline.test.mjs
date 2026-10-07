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

const isHtmlPath = (file) => path.extname(file).toLowerCase() === ".html";
const htmlFiles = tracked.filter(isHtmlPath).sort();
assert.ok(htmlFiles.length > 0, "repository must contain tracked HTML files");
assert.equal(isHtmlPath("index.HTML"), true, "HTML discovery must be case-insensitive");
assert.equal(isHtmlPath("index.HtMl"), true, "HTML discovery must accept mixed-case extensions");
assert.equal(isHtmlPath("index.html.txt"), false, "HTML discovery must reject non-HTML suffixes");

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

function textContent(fragment) {
  return fragment
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAriaName(attrs) {
  return Boolean(
    attrs.get("aria-label")?.trim() ||
    attrs.get("aria-labelledby")?.trim()
  );
}

function hasNativeButtonName(attrs) {
  const type = (attrs.get("type") || "text").toLowerCase();
  if (type === "image") return Boolean(attrs.get("alt")?.trim());
  if (["button", "submit", "reset"].includes(type)) {
    return Boolean(attrs.get("value")?.trim());
  }
  return false;
}

function validateMainLandmarks(file, source) {
  const mains = [...source.matchAll(/<main\b([^>]*)>([\s\S]*?)<\/main>/gi)].map((match) => ({
    source: `<main${match[1]}>`,
    attrs: attributes(`<main${match[1]}>`),
    body: match[2]
  }));

  assert.ok(mains.length > 0, `${file}: document must include a main landmark`);

  const initiallyVisible = mains.filter(({ attrs }) => !attrs.has("hidden"));
  assert.ok(
    initiallyVisible.length <= 1,
    `${file}: document must not expose multiple main landmarks at initial render`
  );

  for (const main of mains) {
    assert.notEqual(
      main.attrs.get("aria-hidden")?.toLowerCase(),
      "true",
      `${file}: main landmark must not use aria-hidden=true: ${main.source}`
    );

    const primaryHeadings = [...main.body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
    assert.equal(
      primaryHeadings.length,
      1,
      `${file}: each main landmark must contain exactly one h1`
    );
    assert.ok(
      textContent(primaryHeadings[0][1]),
      `${file}: main landmark h1 must not be empty`
    );
  }
}

assert.doesNotThrow(() =>
  validateMainLandmarks(
    "self-test-main.html",
    '<main id="home"><h1>Home</h1></main><main id="session" hidden aria-labelledby="sessionTitle"><h1 id="sessionTitle">Session</h1></main>'
  )
);
assert.throws(
  () => validateMainLandmarks("self-test-missing-main.html", "<div></div>"),
  /must include a main landmark/
);
assert.throws(
  () =>
    validateMainLandmarks(
      "self-test-multiple-visible-main.html",
      '<main id="home"><h1>Home</h1></main><main id="session"><h1>Session</h1></main>'
    ),
  /must not expose multiple main landmarks/
);
assert.throws(
  () => validateMainLandmarks("self-test-hidden-main.html", '<main aria-hidden="true"><h1>Hidden</h1></main>'),
  /main landmark must not use aria-hidden=true/
);
assert.throws(
  () => validateMainLandmarks("self-test-main-heading.html", '<main><p>No primary heading</p></main>'),
  /must contain exactly one h1/
);
assert.throws(
  () => validateMainLandmarks("self-test-empty-main-heading.html", '<main><h1></h1></main>'),
  /h1 must not be empty/
);

function validateHtmlAccessibility(file, source) {
  const labelForIds = new Set();
  const wrappedControlIds = new Set();
  const labelableControlIds = new Set();

  for (const control of source.matchAll(/<(button|input|meter|output|progress|select|textarea)\b[^>]*>/gi)) {
    const kind = control[1].toLowerCase();
    const controlAttrs = attributes(control[0]);
    const type = (controlAttrs.get("type") || "").toLowerCase();
    const id = controlAttrs.get("id")?.trim();
    if (id && !(kind === "input" && type === "hidden")) {
      labelableControlIds.add(id);
    }
  }

  for (const label of source.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const labelAttrs = attributes(`<label${label[1]}>`);
    const forId = labelAttrs.get("for")?.trim();

    assert.ok(
      textContent(label[2]),
      `${file}: label must have readable text: ${label[0]}`
    );

    if (forId) {
      assert.ok(
        labelableControlIds.has(forId),
        `${file}: label for="${forId}" must reference a labelable control`
      );
      labelForIds.add(forId);
    }

    for (const control of label[2].matchAll(/<(?:input|select|textarea)\b[^>]*>/gi)) {
      const controlAttrs = attributes(control[0]);
      const id = controlAttrs.get("id")?.trim();
      if (id) wrappedControlIds.add(id);
    }
  }

  for (const tag of source.matchAll(/<[a-z][^>]*>/gi)) {
    const name = tag[0].match(/^<([a-z][\w:-]*)/i)?.[1]?.toLowerCase();
    const attrs = attributes(tag[0]);

    if (attrs.has("tabindex")) {
      const raw = attrs.get("tabindex").trim();
      assert.match(raw, /^-?\d+$/, `${file}: tabindex must be an integer in ${tag[0]}`);
      assert.ok(
        Number(raw) <= 0,
        `${file}: positive tabindex creates a brittle keyboard order in ${tag[0]}`
      );
    }

    const isInteractive =
      name === "button" ||
      name === "input" ||
      name === "select" ||
      name === "textarea" ||
      (name === "a" && attrs.has("href"));

    const role = (attrs.get("role") ?? "").trim().toLowerCase();
    if (role === "button") {
      assert.equal(
        name,
        "button",
        `${file}: role=button must use a native button element instead: ${tag[0]}`
      );
    }
    if (role === "link") {
      assert.equal(
        name === "a" && attrs.has("href"),
        true,
        `${file}: role=link must use a native anchor with href instead: ${tag[0]}`
      );
    }

    if (isInteractive) {
      assert.notEqual(
        attrs.get("aria-hidden")?.toLowerCase(),
        "true",
        `${file}: interactive control must not be hidden from assistive technology: ${tag[0]}`
      );
    }

    if (name === "img") {
      assert.equal(
        attrs.has("alt"),
        true,
        `${file}: img must declare alt text; use alt="" for decorative images`
      );
    }

    if (name === "iframe") {
      assert.ok(
        attrs.get("title")?.trim(),
        `${file}: iframe must have a non-empty title`
      );
    }
  }

  for (const button of source.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const attrs = attributes(`<button${button[1]}>`);
    const type = attrs.get("type")?.trim().toLowerCase();
    assert.ok(
      ["button", "submit", "reset"].includes(type),
      `${file}: button must declare an explicit valid type: ${button[0]}`
    );
    assert.ok(
      hasAriaName(attrs) || textContent(button[2]),
      `${file}: button must have visible text or an ARIA accessible name`
    );
  }

  for (const anchor of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = attributes(`<a${anchor[1]}>`);
    if (!attrs.has("href")) continue;

    assert.ok(
      hasAriaName(attrs) || textContent(anchor[2]),
      `${file}: link with href must have visible text or an ARIA accessible name`
    );
  }

  for (const control of source.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const kind = control[1].toLowerCase();
    const attrs = attributes(control[0]);
    const type = (attrs.get("type") || "text").toLowerCase();

    if (kind === "input" && type === "hidden") continue;

    const id = attrs.get("id")?.trim();
    const labelled =
      hasAriaName(attrs) ||
      hasNativeButtonName(attrs) ||
      (id && (labelForIds.has(id) || wrappedControlIds.has(id)));

    assert.ok(
      labelled,
      `${file}: ${kind} control must have an accessible label/name: ${control[0]}`
    );
  }
}

const validFixture = `
<!doctype html><html lang="en"><head><title>x</title></head><body>
<label for="name">Name</label><input id="name">
<label><span>Enabled</span><input id="enabled" type="checkbox"></label>
<button type="button">Save</button>
<a href="/">Home</a>
<img src="/decorative.svg" alt="">
<img src="/logo.svg" alt="Product logo">
<iframe title="Preview"></iframe>
</body></html>`;
assert.doesNotThrow(() => validateHtmlAccessibility("self-test-valid.html", validFixture));
assert.throws(
  () => validateHtmlAccessibility("self-test-input.html", "<input id=\"orphan\">"),
  /accessible label\/name/
);
assert.throws(
  () =>
    validateHtmlAccessibility(
      "self-test-label-target.html",
      '<label for="note">Note</label><div id="note"></div>'
    ),
  /must reference a labelable control/
);
assert.throws(
  () =>
    validateHtmlAccessibility(
      "self-test-empty-label.html",
      '<label for="name"></label><input id="name">'
    ),
  /label must have readable text/
);
assert.throws(
  () => validateHtmlAccessibility("self-test-button.html", "<button type=\"button\"></button>"),
  /button must have/
);
assert.throws(
  () => validateHtmlAccessibility("self-test-button-type.html", "<button>Save</button>"),
  /button must declare an explicit valid type/
);
assert.throws(
  () => validateHtmlAccessibility("self-test-image.html", '<img src="/logo.svg">'),
  /img must declare alt text/
);
assert.doesNotThrow(() =>
  validateHtmlAccessibility("self-test-decorative-image.html", '<img src="/line.svg" alt="">')
);
assert.throws(
  () => validateHtmlAccessibility("self-test-iframe.html", "<iframe></iframe>"),
  /non-empty title/
);
assert.throws(
  () => validateHtmlAccessibility("self-test-tabindex.html", "<button tabindex=\"2\">Go</button>"),
  /positive tabindex/
);
assert.throws(
  () => validateHtmlAccessibility("self-test-hidden.html", "<button aria-hidden=\"true\">Go</button>"),
  /must not be hidden/
);
assert.throws(
  () => validateHtmlAccessibility("self-test-fake-button.html", '<div role="button" tabindex="0">Go</div>'),
  /role=button must use a native button/
);
assert.throws(
  () => validateHtmlAccessibility("self-test-fake-link.html", '<span role="link" tabindex="0">Help</span>'),
  /role=link must use a native anchor with href/
);

for (const file of htmlFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  validateMainLandmarks(file, source);
  validateHtmlAccessibility(file, source);
}

const workflow = fs.readFileSync(
  path.join(root, ".github/workflows/repository-html-accessibility-baseline.yml"),
  "utf8"
);
assert.doesNotMatch(
  workflow,
  /^\s+paths:\s*$/m,
  "HTML accessibility workflow must run on every PR/push so extension casing cannot bypass validation"
);

console.log(`HTML accessibility baseline passed for ${htmlFiles.length} tracked files`);
