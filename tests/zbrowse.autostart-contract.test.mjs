import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const autostartPath = "zbrowse/browser/root/defaults/autostart_wayland";
const startupPath = "zbrowse/browser/root/usr/local/bin/start-zbrowse";
const dockerfilePath = "zbrowse/browser/Dockerfile";

assert.ok(fs.existsSync(path.join(root, autostartPath)), "Selkies Wayland autostart file must remain present");
assert.ok(fs.existsSync(path.join(root, startupPath)), "zBrowse browser startup script must remain present");

function validateAutostart(source, label) {
  assert.equal(source.endsWith("\n"), true, `${label}: must end with a newline`);
  const commands = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  assert.deepEqual(
    commands,
    ["/usr/local/bin/start-zbrowse"],
    `${label}: must launch only the reviewed zBrowse startup entrypoint`
  );
  assert.doesNotMatch(
    commands[0],
    /[;&|><\x60$]/,
    `${label}: autostart command must not contain shell chaining, redirection, substitution or expansion`
  );
}

assert.doesNotThrow(() => validateAutostart("/usr/local/bin/start-zbrowse\n", "self-test valid"));
assert.throws(
  () => validateAutostart("/usr/local/bin/start-zbrowse; echo unsafe\n", "self-test chained"),
  /must launch only/
);
assert.throws(
  () => validateAutostart("/usr/local/bin/other-browser\n", "self-test wrong entrypoint"),
  /must launch only/
);

validateAutostart(read(autostartPath), autostartPath);

const dockerfile = read(dockerfilePath);
assert.match(
  dockerfile,
  /^COPY root \/$/m,
  "browser image must install the reviewed root overlay that contains autostart_wayland"
);
assert.match(
  dockerfile,
  /^RUN chmod \+x \/usr\/local\/bin\/start-zbrowse$/m,
  "browser image must keep the autostart target executable"
);

console.log("zBrowse Wayland autostart contract passed");
