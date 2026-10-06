const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(
  path.resolve(__dirname, '../zbrowse/gateway/public/app.js'),
  'utf8'
);

assert.ok(app.includes('const session = state.session;'));
assert.ok(app.includes('state.session?.token === session.token'));
assert.ok(app.includes('request("/api/session/" + session.token + "/heartbeat"'));
assert.ok(!app.includes('request("/api/session/" + state.session.token + "/heartbeat"'));

assert.ok(app.includes('window.addEventListener("pagehide", (event) => {'));
assert.ok(app.includes('if (event.persisted) {'));
assert.ok(app.includes('method: "DELETE"'));
assert.ok(app.includes('keepalive: true'));
assert.ok(app.includes('health.activeSessions + health.startingSessions < health.capacity'));

console.log('zBrowse frontend session callback contract passed');
