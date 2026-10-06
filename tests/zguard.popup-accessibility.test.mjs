import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relative) =>
  fs.readFileSync(new URL("../" + relative, import.meta.url), "utf8");

for (const browser of ["chromium", "firefox"]) {
  const html = read(browser + "/popup.html");
  const css = read(browser + "/popup.css");

  assert.match(
    html,
    /<label class="switch"><span class="sr-only">zGuard inschakelen<\/span><input id="enabled" type="checkbox"><span class="track" aria-hidden="true"><\/span><\/label>/,
    browser + ": toggle must retain an accessible label and decorative track"
  );
  assert.doesNotMatch(
    css,
    /\.switch input\s*\{[^}]*display:\s*none/i,
    browser + ": toggle input must stay in the keyboard and accessibility trees"
  );
  assert.match(
    css,
    /\.sr-only, \.switch input\s*\{[^}]*position:\s*absolute;[^}]*width:\s*1px;[^}]*height:\s*1px;/i,
    browser + ": visually hidden toggle input must remain focusable"
  );
  assert.match(
    css,
    /\.switch input:focus-visible \+ \.track, button:focus-visible\s*\{[^}]*outline:/i,
    browser + ": toggle and mode buttons must expose visible keyboard focus"
  );
  assert.match(
    html,
    /<button type="button" data-mode="balanced">Gebalanceerd<\/button>/,
    browser + ": balanced control must be an explicit button"
  );
  assert.match(
    html,
    /<button type="button" data-mode="strict">Streng<\/button>/,
    browser + ": strict control must be an explicit button"
  );
  assert.match(
    html,
    /id="count" aria-live="polite" aria-atomic="true"/,
    browser + ": blocked count changes must be announced atomically"
  );
  assert.match(
    html,
    /id="status" class="status" role="status" aria-live="polite"/,
    browser + ": protection status changes must be announced"
  );
  assert.match(
    html,
    /<script src="popup\.js"><\/script><script src="popup-a11y\.js"><\/script>/,
    browser + ": popup ARIA sync must load after the settings runtime"
  );
}

assert.equal(
  read("zbrowse/browser/zguard/popup.html"),
  read("chromium/popup.html"),
  "zBrowse bundled Chromium popup markup must stay synchronized"
);
assert.equal(
  read("zbrowse/browser/zguard/popup.css"),
  read("chromium/popup.css"),
  "zBrowse bundled Chromium popup styles must stay synchronized"
);

console.log("zGuard popup accessibility contract passed");
