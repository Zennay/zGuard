const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

for (const browser of ['chromium', 'firefox']) {
  const dir = path.join(root, browser);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (!manifest.name || !manifest.version || !manifest.content_scripts?.length) throw new Error(`${browser}: invalid manifest`);
  for (const file of ['background.js', 'content.js', 'popup.html', 'popup.js', 'popup.css']) {
    if (!fs.existsSync(path.join(dir, file))) throw new Error(`${browser}: missing ${file}`);
  }
  if (manifest.manifest_version === 3 && !manifest.background.service_worker) throw new Error('chromium: missing service worker');
  if (manifest.manifest_version === 2 && !manifest.background.scripts?.length) throw new Error('firefox: missing background script');
}
console.log('zGuard smoke tests passed');
