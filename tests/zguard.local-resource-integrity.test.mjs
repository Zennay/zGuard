import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

function assertLocalFile(packageDir, relative, label) {
  assert.equal(typeof relative, "string", `${label}: expected a string resource path`);
  assert.doesNotMatch(relative, /^(?:https?:)?\/\//i, `${label}: remote resources are forbidden`);
  assert.ok(!path.isAbsolute(relative), `${label}: absolute filesystem paths are forbidden`);
  const resolved = path.resolve(root, packageDir, relative);
  const packageRoot = path.resolve(root, packageDir) + path.sep;
  assert.ok(resolved.startsWith(packageRoot), `${label}: resource must stay inside the extension package`);
  assert.ok(fs.existsSync(resolved), `${label}: referenced local file does not exist: ${relative}`);
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
