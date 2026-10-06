import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(
  new URL("../zbrowse/gateway/public/index.html", import.meta.url),
  "utf8"
);
const css = fs.readFileSync(
  new URL("../zbrowse/gateway/public/styles.css", import.meta.url),
  "utf8"
);

assert.match(html, /<html\s+lang="en">/, "document language must remain explicit");
assert.match(
  html,
  /id="urlInput"[^>]*aria-label="Website address"[^>]*aria-describedby="formMessage privacyNote"/,
  "URL input must have a stable accessible name and description"
);
assert.match(
  html,
  /id="formMessage"[^>]*role="status"[^>]*aria-live="polite"/,
  "form feedback must be announced without stealing focus"
);
assert.match(
  html,
  /id="capacityDot"[^>]*aria-hidden="true"/,
  "decorative capacity indicator must stay hidden from assistive technology"
);
assert.match(
  html,
  /class="live-dot"[^>]*aria-hidden="true"/,
  "decorative session indicator must stay hidden from assistive technology"
);
assert.match(
  html,
  /class="sr-only">Session time remaining: <\/span><span id="timer">15:00<\/span>/,
  "session timer must expose its label without masking the changing time value"
);
assert.match(
  css,
  /\.sr-only\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?width:\s*1px;[\s\S]*?height:\s*1px;/,
  "screen-reader-only text must stay visually hidden without display:none"
);
assert.match(
  html,
  /id="browserLoading"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/,
  "browser startup state must be announced as one polite status"
);
assert.match(
  html,
  /class="spinner"[^>]*aria-hidden="true"/,
  "visual loading spinner must stay hidden from assistive technology"
);
assert.match(
  html,
  /id="fullscreenButton"[^>]*aria-controls="browserStage"/,
  "fullscreen control must identify the controlled browser region"
);
assert.match(
  html,
  /id="browserFrame"[^>]*title="zBrowse browser session"[^>]*referrerpolicy="no-referrer"/,
  "browser iframe must retain its accessible title and privacy referrer policy"
);
assert.match(
  css,
  /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
  "portal must honor reduced-motion preferences"
);
assert.match(
  css,
  /:focus-visible/,
  "keyboard focus must retain a visible focus treatment"
);

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

const placeholder = css.match(/\.searchbar input::placeholder \{ color: (#[0-9a-f]{6}); \}/i)?.[1];
const privacy = css.match(/\.privacy-note \{[\s\S]*?color: (#[0-9a-f]{6});/i)?.[1];
assert.ok(placeholder, "placeholder color must remain explicit");
assert.ok(privacy, "privacy note color must remain explicit");
assert.ok(
  contrast(placeholder, "#151518") >= 4.5,
  "URL placeholder must retain at least 4.5:1 contrast against the search surface"
);
assert.ok(
  contrast(privacy, "#09090b") >= 4.5,
  "privacy note must retain at least 4.5:1 contrast against the page background"
);
const accent = css.match(/--accent:\s*(#[0-9a-f]{6});/i)?.[1];
const accentHover = css.match(/--accent-hover:\s*(#[0-9a-f]{6});/i)?.[1];
assert.ok(accent, "primary accent color must remain explicit");
assert.ok(accentHover, "hover accent color must remain explicit");
assert.ok(
  contrast("#ffffff", accent) >= 4.5,
  "white button text must retain at least 4.5:1 contrast on the primary accent"
);
assert.ok(
  contrast("#ffffff", accentHover) >= 4.5,
  "white button text must retain at least 4.5:1 contrast on the hover accent"
);

console.log("zBrowse portal accessibility contract passed");
