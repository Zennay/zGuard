const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');

for (const browser of ['chromium', 'firefox']) {
  const dir = path.join(root, browser);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (!manifest.name || !manifest.version || !manifest.content_scripts?.length) {
    throw new Error(`${browser}: invalid manifest`);
  }

  for (const file of ['background.js', 'content.js', 'popup.html', 'popup.js', 'popup.css']) {
    const fullPath = path.join(dir, file);
    if (!fs.existsSync(fullPath)) throw new Error(`${browser}: missing ${file}`);
    if (file.endsWith('.js')) {
      execFileSync(process.execPath, ['--check', fullPath], { stdio: 'pipe' });
    }
  }

  const popupHtml = fs.readFileSync(path.join(dir, 'popup.html'), 'utf8');
  if (!popupHtml.includes('popup.css') || !popupHtml.includes('popup.js')) {
    throw new Error(`${browser}: popup assets are not wired`);
  }

  if (manifest.manifest_version === 3 && !manifest.background.service_worker) {
    throw new Error('chromium: missing service worker');
  }
  if (manifest.manifest_version === 2 && !manifest.background.scripts?.length) {
    throw new Error('firefox: missing background script');
  }
}

execFileSync(process.execPath, [path.join(__dirname, 'content-mode.test.js')], { stdio: 'inherit' });
console.log('zGuard smoke tests passed');
