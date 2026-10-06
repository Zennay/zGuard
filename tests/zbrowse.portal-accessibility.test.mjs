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

console.log("zBrowse portal accessibility contract passed");
