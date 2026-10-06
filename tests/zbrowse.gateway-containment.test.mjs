import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const compose = fs.readFileSync(path.join(root, 'zbrowse/docker-compose.yml'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'zbrowse/README.md'), 'utf8');
const workflow = fs.readFileSync(
  path.join(root, '.github/workflows/gateway-containment-validation.yml'),
  'utf8'
);

const gatewayMatch = compose.match(/services:\n  gateway:\n([\s\S]*?)\nnetworks:/);
assert.ok(gatewayMatch, 'docker-compose.yml must define the gateway service');
const gateway = gatewayMatch[1];

assert.match(gateway, /\n    read_only:\s*true\s*$/m, 'gateway root filesystem must be read-only');
assert.match(gateway, /\n    init:\s*true\s*$/m, 'gateway must use an init process');
assert.match(
  gateway,
  /\n    cap_drop:\s*\n\s+-\s+ALL\s*$/m,
  'gateway must drop all Linux capabilities'
);
assert.match(
  gateway,
  /\n    security_opt:\s*\n\s+-\s+no-new-privileges:true\s*$/m,
  'gateway must prevent privilege escalation'
);
assert.match(
  gateway,
  /\n    tmpfs:\s*\n\s+-\s+\/tmp:rw,noexec,nosuid,nodev,size=64m\s*$/m,
  'gateway must provide only a bounded hardened writable /tmp'
);
assert.match(
  gateway,
  /\n    healthcheck:\s*\n\s+test:\s*[\s\S]*?\/api\/health[\s\S]*?\n\s+interval:\s+30s\s*\n\s+timeout:\s+5s\s*\n\s+retries:\s+3\s*\n\s+start_period:\s+5s\s*$/m,
  'gateway must expose a bounded application-level healthcheck'
);
assert.match(
  gateway,
  /\n    logging:\s*\n\s+driver:\s+json-file\s*\n\s+options:\s*\n\s+max-size:\s+["']10m["']\s*\n\s+max-file:\s+["']3["']\s*$/m,
  'gateway logs must be rotated to prevent unbounded host-disk growth'
);

assert.match(readme, /read-only rootfilesystem/, 'README must document the read-only gateway root');
assert.match(readme, /no-new-privileges/, 'README must document privilege-escalation hardening');
assert.match(readme, /Docker-healthcheck controleert de bestaande `\/api\/health`-route/, 'README must document the application healthcheck');
assert.match(readme, /docker compose ps gateway/, 'README must document how to inspect gateway health');
assert.match(readme, /portable hosted runner/, 'README must describe the executable gateway CI gate');
assert.match(
  readme,
  /effectieve draaiende container/,
  'README must document live effective-containment verification'
);
assert.match(
  readme,
  /Docker API-ping/,
  'README must document the live non-root Docker socket access proof'
);

assert.match(workflow, /runs-on:\s*ubuntu-latest/, 'containment validation must use a portable hosted runner');
assert.match(workflow, /timeout-minutes:\s*[1-9][0-9]*/, 'containment validation must have a bounded timeout');
assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/, 'workflow token must remain read-only');
assert.match(
  workflow,
  /uses:\s*actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/,
  'checkout must be pinned to the reviewed v6.0.3 commit'
);
assert.match(workflow, /persist-credentials:\s*false/, 'checkout credentials must not persist');
assert.match(
  workflow,
  /bash zbrowse\/scripts\/validate\.sh/,
  'containment workflow must execute the full portable zBrowse validation suite'
);
assert.match(
  workflow,
  /- "zbrowse\/scripts\/validate\.sh"/,
  'validate.sh changes must trigger the containment workflow'
);
assert.match(
  workflow,
  /- "tests\/zbrowse\.validation-entrypoint\.test\.mjs"/,
  'validation entrypoint contract changes must trigger the containment workflow'
);
assert.match(
  workflow,
  /node tests\/zbrowse\.gateway-containment\.test\.mjs/,
  'workflow must execute the gateway containment regression'
);
assert.match(workflow, /docker compose config >\/dev\/null/, 'workflow must validate Compose syntax');
assert.match(
  workflow,
  /export DOCKER_GID="\$\(stat -c '%g' \/var\/run\/docker\.sock\)"/,
  'workflow must derive the real Docker socket group before boot'
);
assert.match(workflow, /docker compose up -d --build gateway/, 'workflow must boot the hardened gateway');
assert.match(workflow, /\.State\.Health\.Status/, 'workflow must wait for Docker health state');
assert.match(
  workflow,
  /node \.\.\/tests\/zbrowse\.gateway-runtime\.test\.mjs zbrowse-gateway/,
  'workflow must assert the effective running gateway container'
);
assert.match(
  workflow,
  /- "tests\/zbrowse\.gateway-runtime\.test\.mjs"/,
  'live runtime-test changes must trigger the containment gate'
);
assert.match(
  workflow,
  /- "zbrowse\/gateway\/\*\*"/,
  'all gateway runtime input changes must trigger the live containment gate'
);
assert.match(workflow, /- "zbrowse\/README\.md"/, 'README changes must trigger the containment gate');

console.log('zBrowse gateway containment contract passed');
