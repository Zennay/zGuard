import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

function assertResolvedPackageFile(packageRoot, resolved, label) {
  const realPackageRoot = fs.realpathSync(packageRoot);
  const realResolved = fs.realpathSync(resolved);

  assert.ok(
    realResolved.startsWith(realPackageRoot + path.sep),
    `${label}: resource symlink must stay inside the extension package`
  );
  assert.ok(
    fs.statSync(realResolved).isFile(),
    `${label}: referenced resource must resolve to a regular file`
  );
}

function assertLocalFile(packageDir, relative, label) {
  assert.equal(typeof relative, "string", `${label}: expected a string resource path`);
  assert.doesNotMatch(relative, /^(?:https?:)?\/\//i, `${label}: remote resources are forbidden`);
  assert.ok(!path.isAbsolute(relative), `${label}: absolute filesystem paths are forbidden`);
  const packageRoot = path.resolve(root, packageDir);
  const resolved = path.resolve(packageRoot, relative);
  assert.ok(
    resolved.startsWith(packageRoot + path.sep),
    `${label}: resource must stay inside the extension package`
  );
  assert.ok(fs.existsSync(resolved), `${label}: referenced local file does not exist: ${relative}`);
  assertResolvedPackageFile(packageRoot, resolved, label);
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zguard-resource-boundary-"));
try {
  const fixturePackage = path.join(fixtureRoot, "package");
  fs.mkdirSync(fixturePackage);
  const inside = path.join(fixturePackage, "inside.js");
  const outside = path.join(fixtureRoot, "outside.js");
  const escape = path.join(fixturePackage, "escape.js");
  const directory = path.join(fixturePackage, "directory.js");
  fs.writeFileSync(inside, "export {};\n");
  fs.writeFileSync(outside, "export {};\n");
  fs.symlinkSync("../outside.js", escape);
  fs.mkdirSync(directory);

  assert.doesNotThrow(() => assertResolvedPackageFile(fixturePackage, inside, "fixture inside"));
  assert.throws(
    () => assertResolvedPackageFile(fixturePackage, escape, "fixture escape"),
    /resource symlink must stay inside the extension package/
  );
  assert.throws(
    () => assertResolvedPackageFile(fixturePackage, directory, "fixture directory"),
    /referenced resource must resolve to a regular file/
  );
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

for (const packageDir of ["chromium", "firefox"]) {
  const manifest = readJson(`${packageDir}/manifest.json`);

  assert.equal(manifest.update_url, undefined, `${packageDir}: remote update_url must stay absent`);
  assert.equal(manifest.external_connectable, undefined, `${packageDir}: external_connectable must stay absent`);

  if (manifest.background?.service_worker) {
    assertLocalFile(packageDir, manifest.background.service_worker, `${packageDir} background service worker`);
  }
  for (const script of manifest.background?.scripts || []) {
    assertLocalFile(packageDir, script, `${packageDir} background script`);
  }

  const popup = manifest.action?.default_popup || manifest.browser_action?.default_popup;
  assertLocalFile(packageDir, popup, `${packageDir} popup`);

  for (const [index, entry] of (manifest.content_scripts || []).entries()) {
    for (const script of entry.js || []) {
      assertLocalFile(packageDir, script, `${packageDir} content script #${index + 1}`);
    }
    for (const stylesheet of entry.css || []) {
      assertLocalFile(packageDir, stylesheet, `${packageDir} content stylesheet #${index + 1}`);
    }
  }

  const popupHtml = fs.readFileSync(path.join(root, packageDir, popup), "utf8");
  for (const match of popupHtml.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)) {
    assertLocalFile(packageDir, match[1], `${packageDir} popup asset`);
  }
}

console.log("zGuard local resource integrity contract passed");
