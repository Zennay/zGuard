#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"

node --check gateway/server.js
node --check gateway/public/app.js
node -e "for (const f of ['gateway/package.json','gateway/config/sites.json','browser/policies/policy.json']) JSON.parse(require('fs').readFileSync(f,'utf8'));"
node ../tests/zbrowse.contract.test.js
node ../tests/zbrowse.request-ip.test.mjs
node ../tests/zbrowse.request-path.test.mjs
node ../tests/zbrowse.config-values.test.mjs
node ../tests/zbrowse.session-admission.test.mjs
node ../tests/zbrowse.session-lifetime.test.mjs
node ../tests/zbrowse.session-capacity.test.mjs
node ../tests/zbrowse.managed-containers.test.mjs
node ../tests/zbrowse.frontend-session.test.js
bash -n scripts/install.sh
bash -n browser/root/usr/local/bin/start-zbrowse
if command -v docker >/dev/null 2>&1; then
  docker compose config >/dev/null
fi
echo "zBrowse validation passed"
