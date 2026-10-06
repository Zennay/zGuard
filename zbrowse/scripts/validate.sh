#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"

node --check gateway/server.js
node --check gateway/public/app.js
node -e "for (const f of ['gateway/package.json','gateway/config/sites.json','browser/policies/policy.json']) JSON.parse(require('fs').readFileSync(f,'utf8'));"
node ../tests/zbrowse.contract.test.js
node ../tests/zbrowse.request-ip.test.mjs
bash -n scripts/install.sh
if command -v docker >/dev/null 2>&1; then
  docker compose config >/dev/null
fi
echo "zBrowse validation passed"
