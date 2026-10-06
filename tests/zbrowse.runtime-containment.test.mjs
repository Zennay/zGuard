import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("../zbrowse/gateway/server.js", import.meta.url),
  "utf8"
);

const createCall = source.match(/docker\.createContainer\(\{([\s\S]*?)\n  \}\);/);
assert.ok(createCall, "gateway must create browser containers through docker.createContainer");

const config = createCall[1];

assert.match(config, /AutoRemove:\s*true/, "browser containers must auto-remove");
assert.match(config, /NetworkMode:\s*config\.network/, "browser containers must stay on the configured isolated network");
assert.match(config, /Memory:\s*config\.memoryBytes/, "browser containers must retain a memory limit");
assert.match(config, /NanoCpus:\s*config\.nanoCpus/, "browser containers must retain a CPU limit");
assert.match(config, /PidsLimit:\s*\d+/, "browser containers must retain a PID limit");
assert.match(
  config,
  /SecurityOpt:\s*\[\s*["']no-new-privileges:true["']\s*\]/,
  "browser containers must disable privilege escalation"
);
assert.match(
  config,
  /["']\/config["']:\s*["']rw,noexec,nosuid,size=/,
  "/config tmpfs must remain noexec and nosuid"
);
assert.match(
  config,
  /["']\/tmp["']:\s*["']rw,noexec,nosuid,size=/,
  "/tmp tmpfs must remain noexec and nosuid"
);

assert.doesNotMatch(config, /\bPrivileged:\s*true/, "browser containers must never be privileged");
assert.doesNotMatch(config, /NetworkMode:\s*["']host["']/, "browser containers must never use host networking");
assert.doesNotMatch(config, /\bBinds\s*:/, "browser containers must not receive host bind mounts");
assert.doesNotMatch(config, /\bPortBindings\s*:/, "browser containers must not publish host ports");

console.log("zBrowse runtime containment contract passed");
