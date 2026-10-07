import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = [".github", "chromium", "firefox", "zbrowse"];
const ignoredDirectories = new Set(["node_modules", ".git"]);
const textExtensions = new Set([
  ".js", ".mjs", ".cjs", ".json", ".yml", ".yaml", ".md", ".txt",
  ".html", ".css", ".sh", ".env", ".example", ".conf", ".ini"
]);

const signatures = [
  { name: "PEM private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "GitHub classic token", pattern: new RegExp("gh" + "[opusr]_[A-Za-z0-9]{20,}") },
  { name: "GitHub fine-grained token", pattern: new RegExp("github" + "_pat_[A-Za-z0-9_]{20,}") },
  { name: "OpenAI-style secret", pattern: new RegExp("sk" + "-[A-Za-z0-9_-]{20,}") },
  { name: "AWS access key id", pattern: new RegExp("AK" + "IA[0-9A-Z]{16}") },
  { name: "Slack bot token", pattern: new RegExp("xox" + "b-[0-9A-Za-z-]{20,}") }
];

const findings = [];

function shouldRead(filePath) {
  const base = path.basename(filePath);
  if (base === ".env.example") return true;
  return textExtensions.has(path.extname(filePath));
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(full);
      continue;
    }

    if (!entry.isFile() || !shouldRead(full)) continue;

    const content = fs.readFileSync(full, "utf8");
    for (const signature of signatures) {
      if (signature.pattern.test(content)) {
        findings.push({
          file: path.relative(root, full),
          signature: signature.name
        });
      }
    }
  }
}

for (const relative of scanRoots) {
  const absolute = path.join(root, relative);
  if (fs.existsSync(absolute)) walk(absolute);
}

assert.deepEqual(
  findings,
  [],
  "repository source/config contains high-confidence secret material: " +
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

console.log("repository secret hygiene contract passed");
