import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerPath = path.join(root, "zbrowse/scripts/install.sh");
const source = fs.readFileSync(installerPath, "utf8");
const lines = source.split(/\r?\n/);

function firstLine(pattern, label) {
  const index = lines.findIndex((line) => pattern.test(line));
  assert.notEqual(index, -1, `installer must contain ${label}`);
  return index + 1;
}

const validationLine = firstLine(/^bash scripts\/validate\.sh$/, "full validation entrypoint");

for (const [pattern, label] of [
  [/command -v docker/, "Docker prerequisite check"],
  [/docker compose version/, "Compose prerequisite check"],
  [/command -v node/, "Node prerequisite check"],
  [/\[\[ ! -S \/var\/run\/docker\.sock \]\]/, "Docker socket prerequisite check"],
  [/docker info >\/dev\/null 2>&1/, "Docker daemon access check"]
]) {
  assert.ok(
    firstLine(pattern, label) < validationLine,
    `${label} must run before full validation`
  );
}

for (const [pattern, label] of [
  [/^\s*cp \.env\.example \.env$/, ".env creation"],
  [/^docker_gid=.*stat -c/, "Docker GID lookup for local config"],
  [/^\s*sed -i .*DOCKER_GID=/, "existing .env mutation"],
  [/>> \.env$/, "missing DOCKER_GID append"],
  [/^docker build /, "browser image build"],
  [/^docker compose up /, "gateway deployment"]
]) {
  assert.ok(
    validationLine < firstLine(pattern, label),
    `full validation must fail closed before ${label}`
  );
}

assert.equal(
  lines.filter((line) => line === "bash scripts/validate.sh").length,
  1,
  "installer must invoke the validation entrypoint exactly once"
);

console.log("zBrowse installer validation-order contract passed");
