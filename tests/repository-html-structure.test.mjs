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

const voidElements = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"
]);
const textParsingElements = new Set(["script", "style", "title", "textarea"]);

function findTagEnd(source, start) {
  let quote = null;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === ">") return index;
  }

  return -1;
}

function countStartTags(source, name) {
  return [...source.matchAll(new RegExp(`<${name}\\b`, "gi"))].length;
}

function assertDocumentSkeleton(file, source) {
  for (const name of ["html", "head", "body"]) {
    assert.equal(
      countStartTags(source, name),
      1,
      `${file}: document must contain exactly one <${name}> element`
    );
  }

  const lower = source.toLowerCase();
  const htmlStart = lower.indexOf("<html");
  const headStart = lower.indexOf("<head");
  const headEnd = lower.indexOf("</head>");
  const bodyStart = lower.indexOf("<body");
  const bodyEnd = lower.indexOf("</body>");
  const htmlEnd = lower.indexOf("</html>");

  assert.ok(
    htmlStart < headStart &&
      headStart < headEnd &&
      headEnd < bodyStart &&
      bodyStart < bodyEnd &&
      bodyEnd < htmlEnd,
    `${file}: expected document order is html > head, then body, then closing html`
  );
}

function validateHtmlStructure(file, source) {
  const stack = [];
  let cursor = 0;

  while (cursor < source.length) {
    const tagStart = source.indexOf("<", cursor);
    if (tagStart === -1) break;

    if (source.startsWith("<!--", tagStart)) {
      const commentEnd = source.indexOf("-->", tagStart + 4);
      assert.notEqual(commentEnd, -1, `${file}: unterminated HTML comment`);
      cursor = commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(source, tagStart + 1);
    assert.notEqual(tagEnd, -1, `${file}: unterminated HTML tag near offset ${tagStart}`);

    const token = source.slice(tagStart + 1, tagEnd).trim();

    if (/^!doctype\b/i.test(token)) {
      cursor = tagEnd + 1;
      continue;
    }

    assert.equal(
      token.startsWith("!"),
      false,
      `${file}: unsupported declaration <${token}> near offset ${tagStart}`
    );
    assert.equal(
      token.startsWith("?"),
      false,
      `${file}: processing instructions are not valid repository HTML near offset ${tagStart}`
    );

    if (token.startsWith("/")) {
      const closing = token.match(/^\/\s*([A-Za-z][\w:-]*)\s*$/);
      assert.ok(closing, `${file}: malformed closing tag <${token}> near offset ${tagStart}`);

      const name = closing[1].toLowerCase();
      const open = stack.pop();
      assert.equal(
        open,
        name,
        `${file}: closing </${name}> does not match open <${open ?? "none"}>`
      );
      cursor = tagEnd + 1;
      continue;
    }

    const opening = token.match(/^([A-Za-z][\w:-]*)\b/);
    assert.ok(opening, `${file}: malformed opening tag <${token}> near offset ${tagStart}`);

    const name = opening[1].toLowerCase();
    const selfClosing = /\/\s*$/.test(token);

    if (selfClosing) {
      assert.ok(
        voidElements.has(name),
        `${file}: non-void <${name}/> is misleading in HTML; use an explicit closing tag`
      );
      cursor = tagEnd + 1;
      continue;
    }

    if (voidElements.has(name)) {
      cursor = tagEnd + 1;
      continue;
    }

    stack.push(name);

    if (textParsingElements.has(name)) {
      const closePattern = new RegExp(`<\\/\\s*${name}\\s*>`, "ig");
      closePattern.lastIndex = tagEnd + 1;
      const close = closePattern.exec(source);
      assert.ok(close, `${file}: unclosed <${name}> element`);
      stack.pop();
      cursor = close.index + close[0].length;
      continue;
    }

    cursor = tagEnd + 1;
  }

  assert.deepEqual(
    stack,
    [],
    `${file}: unclosed HTML elements: ${stack.map((name) => `<${name}>`).join(", ")}`
  );
}

validateHtmlStructure(
  "self-test-valid.html",
  '<!doctype html><html><body><main><p title="1 > 0">ok<br></p></main></body></html>'
);
validateHtmlStructure(
  "self-test-raw-text.html",
  '<!doctype html><html><body><script>if (a < b) console.log("<div>");</script></body></html>'
);
validateHtmlStructure(
  "self-test-rcdata.html",
  '<!doctype html><html><head><title>1 < 2</title></head><body><textarea>Use <tag> literally</textarea></body></html>'
);
assert.throws(
  () => validateHtmlStructure("self-test-unclosed-rcdata.html", "<textarea>missing close"),
  /unclosed <textarea> element/
);
assert.throws(
  () => validateHtmlStructure("self-test-mismatch.html", "<div><span></div></span>"),
  /does not match/
);
assert.throws(
  () => validateHtmlStructure("self-test-unclosed.html", "<div><span></span>"),
  /unclosed HTML elements/
);
assert.throws(
  () => validateHtmlStructure("self-test-comment.html", "<div><!-- missing close</div>"),
  /unterminated HTML comment/
);
assert.throws(
  () => validateHtmlStructure("self-test-self-close.html", "<div/>"),
  /non-void/
);
assertDocumentSkeleton(
  "self-test-skeleton.html",
  "<!doctype html><html><head><title>x</title></head><body><main>x</main></body></html>"
);
assert.throws(
  () =>
    assertDocumentSkeleton(
      "self-test-duplicate-body.html",
      "<!doctype html><html><head><title>x</title></head><body></body><body></body></html>"
    ),
  /exactly one <body>/
);

for (const file of htmlFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  validateHtmlStructure(file, source);
  assertDocumentSkeleton(file, source);
}

const workflow = fs.readFileSync(
  path.join(root, ".github/workflows/repository-html-structure.yml"),
  "utf8"
);
assert.doesNotMatch(
  workflow,
  /^\s+paths:\s*$/m,
  "HTML structure workflow must run on every PR/push so extension casing cannot bypass validation"
);

console.log(`HTML tag structure integrity passed for ${htmlFiles.length} tracked files`);
