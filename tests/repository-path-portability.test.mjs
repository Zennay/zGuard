import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

assert.ok(tracked.length > 0, "at least one tracked path must be discovered");

const windowsReserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const windowsForbidden = /[<>:"\\|?*]/;
const unsafeInvisibleCharacter = /[\u0001-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const portableKeys = new Map();

assert.match("COM¹.txt", windowsReserved, "Windows superscript COM device names must be rejected");
assert.match("lpt²", windowsReserved, "Windows superscript LPT device names must be rejected");
assert.match("COM³", windowsReserved, "all documented superscript COM device digits must be rejected");
assert.match("LPT³.log", windowsReserved, "superscript LPT device names stay reserved with extensions");
assert.doesNotMatch("component¹.txt", windowsReserved, "ordinary superscript filenames must remain allowed");
assert.notEqual("cafe\u0301.txt", "cafe\u0301.txt".normalize("NFC"), "NFD self-test fixture must not already be NFC");
assert.equal("café.txt", "café.txt".normalize("NFC"), "NFC self-test fixture must remain stable");

for (const file of tracked) {
  assert.equal(
    file,
    file.normalize("NFC"),
    `tracked path must use NFC Unicode normalization for cross-filesystem portability: ${JSON.stringify(file)}`
  );

  const segments = file.split("/");

  for (const segment of segments) {
    assert.ok(segment.length > 0, `tracked path has an empty segment: ${file}`);
    assert.notEqual(segment, ".", `tracked path contains '.' segment: ${file}`);
    assert.notEqual(segment, "..", `tracked path contains '..' segment: ${file}`);
    assert.doesNotMatch(
      segment,
      /[. ]$/,
      `tracked path segment ends in a dot or space and is not Windows-portable: ${file}`
    );
    assert.doesNotMatch(
      segment,
      windowsForbidden,
      `tracked path contains a Windows-forbidden character: ${file}`
    );
    assert.doesNotMatch(
      segment,
      unsafeInvisibleCharacter,
      `tracked path contains an unsafe control/format character: ${JSON.stringify(file)}`
    );
    assert.doesNotMatch(
      segment,
      windowsReserved,
      `tracked path uses a Windows-reserved device name: ${file}`
    );
  }

  const portableKey = file.normalize("NFC").toLowerCase();
  const previous = portableKeys.get(portableKey);
  assert.equal(
    previous,
    undefined,
    `tracked paths collide on case-insensitive/normalized filesystems: ${previous} <-> ${file}`
  );
  portableKeys.set(portableKey, file);
}

console.log(`repository path portability contract passed for ${tracked.length} tracked paths`);
