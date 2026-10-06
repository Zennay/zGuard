import assert from "node:assert/strict";
import fs from "node:fs";

const dockerfiles = [
  {
    path: new URL("../zbrowse/browser/Dockerfile", import.meta.url),
    expectedTag: "ghcr.io/linuxserver/baseimage-selkies:debiantrixie",
  },
  {
    path: new URL("../zbrowse/gateway/Dockerfile", import.meta.url),
    expectedTag: "node:22-alpine",
  },
];

for (const { path, expectedTag } of dockerfiles) {
  const source = fs.readFileSync(path, "utf8");
  const from = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("FROM "));

  assert.ok(from, `${path.pathname} must declare a FROM base`);

  const image = from.slice("FROM ".length).trim().split(/\s+/)[0];
  const escapedTag = expectedTag.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
  const pinned = new RegExp(`^${escapedTag}@sha256:[0-9a-f]{64}$`);

  assert.match(
    image,
    pinned,
    `${path.pathname} must pin ${expectedTag} to an immutable sha256 digest`,
  );
}

console.log("zBrowse base-image provenance contract passed");
