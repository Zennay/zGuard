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
node ../tests/zbrowse.base-provenance.test.mjs
node ../tests/zbrowse.session-admission.test.mjs
node ../tests/zbrowse.session-lifetime.test.mjs
node ../tests/zbrowse.frontend-session.test.js
node ../tests/zbrowse.gateway-containment.test.mjs
node ../tests/zbrowse.gateway-dependency-audit.test.mjs
node ../tests/zbrowse.install-preflight.test.mjs
node ../tests/zbrowse.install-validation-order.test.mjs
node ../tests/zbrowse.portal-accessibility.test.mjs
node ../tests/zbrowse.repository-hygiene.test.js
# Release-safety checks run with offline fixtures only. A local validation
# must never contact the public TV origin or allocate browser sessions.
node ../tests/zbrowse.iframe-capability-boundary.test.mjs
node ../tests/zbrowse.public-origin-readiness.test.mjs --self-test
node ../tests/zbrowse.public-tv-static-release.test.mjs --self-test
# Security-sensitive gateway invariants must fail closed during local
# preflight, not only after deploying or invoking dedicated hosted workflows.
# All five tests use filesystem/source fixtures and never contact the public TV.
node ../tests/zbrowse.sites-config-safety.test.mjs
node ../tests/zbrowse.security-headers-contract.test.mjs
node ../tests/zbrowse.start-url-allowlist.test.mjs --require-credential-free
node ../tests/zbrowse.session-cache-privacy.test.mjs --require-no-store
node ../tests/zbrowse.viewer-cache-privacy.test.mjs --require-no-store
node ../tests/zbrowse.validation-entrypoint.test.mjs
bash -n scripts/install.sh
bash -n browser/root/usr/local/bin/start-zbrowse
if command -v docker >/dev/null 2>&1; then
  docker compose config >/dev/null
fi
echo "zBrowse validation passed"
