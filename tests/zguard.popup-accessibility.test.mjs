import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relative) =>
  fs.readFileSync(new URL("../" + relative, import.meta.url), "utf8");

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    .map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) =>
      channel <= 0.03928
        ? channel / 12.92
        : Math.pow((channel + 0.055) / 1.055, 2.4)
    );

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

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
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.switch \.track::after\s*\{[^}]*transition:\s*none;/i,
    browser + ": toggle animation must stop when reduced motion is requested"
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

  const background = css.match(/body\s*\{[^}]*background:\s*(#[0-9a-f]{6})/i)?.[1];
  const mutedText = css.match(/\bp\s*\{[^}]*color:\s*(#[0-9a-f]{6})/i)?.[1];
  const buttonColors = css.match(
    /\bbutton\s*\{[^}]*background:\s*(#[0-9a-f]{6});[^}]*color:\s*(#[0-9a-f]{6})/i
  );
  const focus = css.match(/outline:\s*2px solid (#[0-9a-f]{6})/i)?.[1];
  const status = css.match(/\.status\s*\{[^}]*color:\s*(#[0-9a-f]{6})/i)?.[1];
  const statusOff = css.match(/\.status\.off\s*\{[^}]*color:\s*(#[0-9a-f]{6})/i)?.[1];

  assert.ok(background, browser + ": body background color must remain explicit");
  assert.ok(mutedText, browser + ": muted paragraph color must remain explicit");
  assert.ok(buttonColors, browser + ": button foreground/background colors must remain explicit");
  assert.ok(focus, browser + ": focus outline color must remain explicit");
  assert.ok(status, browser + ": active status color must remain explicit");
  assert.ok(statusOff, browser + ": inactive status color must remain explicit");

  assert.ok(
    contrast(mutedText, background) >= 4.5,
    browser + ": muted popup copy must retain at least 4.5:1 contrast"
  );
  assert.ok(
    contrast(buttonColors[2], buttonColors[1]) >= 4.5,
    browser + ": mode button text must retain at least 4.5:1 contrast"
  );
  assert.ok(
    contrast(status, background) >= 4.5,
    browser + ": active protection status must retain at least 4.5:1 contrast"
  );
  assert.ok(
    contrast(statusOff, background) >= 4.5,
    browser + ": inactive protection status must retain at least 4.5:1 contrast"
  );
  assert.ok(
    contrast(focus, background) >= 3,
    browser + ": focus indicator must retain at least 3:1 contrast on the popup background"
  );
  assert.ok(
    contrast(focus, buttonColors[1]) >= 3,
    browser + ": focus indicator must retain at least 3:1 contrast on mode buttons"
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
