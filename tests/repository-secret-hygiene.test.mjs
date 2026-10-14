import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const signatures = [
  {
    name: "PEM private key",
    pattern: new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----")
  },
  { name: "GitHub classic token", pattern: new RegExp("gh" + "[opusr]_[A-Za-z0-9]{20,}") },
  { name: "GitHub fine-grained token", pattern: new RegExp("github" + "_pat_[A-Za-z0-9_]{20,}") },
  { name: "OpenAI-style secret", pattern: new RegExp("(?<![A-Za-z0-9])sk" + "-[A-Za-z0-9_-]{20,}") },
  { name: "AWS access key id", pattern: new RegExp("AK" + "IA[0-9A-Z]{16}") },
  { name: "Slack bot token", pattern: new RegExp("xox" + "b-[0-9A-Za-z-]{20,}") }
];

// A token marker is a separate prefix, not the trailing letters of an
// ordinary word. For example a long QA filename beginning with "kiosk-"
// contains "sk-" mid-word, which is NOT an API key. Keep standalone keys
// in JSON, shell assignment and HTTP Authorization text detectable.
const tokenPattern = signatures.find(item =>
  item.name === "OpenAI-style secret")?.pattern;
assert.ok(tokenPattern, "reviewed token pattern must exist");
function verifyTokenBoundary(pattern) {
  const simulatedKey = "sk" + "-" + "A".repeat(32);
  for (const real of [
    simulatedKey,
    "KEY=" + simulatedKey,
    "Bearer " + simulatedKey,
    "{\"key\":\"" + simulatedKey + "\"}",
    "(" + simulatedKey + ")"
  ]) {
    assert.equal(pattern.test(real), true,
      "standalone API token must still be detected regardless of wrapping");
  }
  for (const harmless of [
    "kiosk-coldstart-launch-real-shell.test.mjs",
    "prefix" + simulatedKey,
    "task" + simulatedKey,
    "sk" + "-" + "A".repeat(19)
  ]) {
    assert.equal(pattern.test(harmless), false,
      "embedded or short token-like text must not trip secret hygiene");
  }
}
verifyTokenBoundary(tokenPattern);
// Prove that a regression to the old unbounded-prefix detector fails QA.
assert.throws(() => verifyTokenBoundary(new RegExp("sk" + "-[A-Za-z0-9_-]{20,}")),
  undefined, "removing the token boundary must be caught by this self-test");

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8"
}).split("\0").filter(Boolean);

assert.ok(tracked.length > 0, "at least one tracked file must be discovered");

const findings = [];

for (const relative of tracked) {
  const buffer = fs.readFileSync(path.join(root, relative));

  // Git may track binary assets; NUL is a conservative binary signal for this
  // high-confidence text signature scan.
  if (buffer.includes(0)) continue;

  const content = buffer.toString("utf8");
  for (const signature of signatures) {
    if (signature.pattern.test(content)) {
      findings.push({ file: relative, signature: signature.name });
    }
  }
}

assert.deepEqual(
  findings,
  [],
  "tracked repository content contains high-confidence secret material: " +
    findings.map(({ file, signature }) => `${file} (${signature})`).join(", ")
);

const envExample = fs.readFileSync(path.join(root, "zbrowse/.env.example"), "utf8");
for (const line of envExample.split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const [key, ...rest] = line.split("=");
  const value = rest.join("=");
  assert.ok(value.length > 0, `${key}: tracked example values must be explicit placeholders/defaults`);
  assert.doesNotMatch(
    key,
    /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)$/i,
    `${key}: secret-bearing variables must not be committed with tracked example values`
  );
}

console.log(`repository secret hygiene contract passed for ${tracked.length} tracked files`);
