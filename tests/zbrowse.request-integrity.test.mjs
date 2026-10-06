import assert from "node:assert/strict";
import { blockCrossSiteWrite, isJsonContentType, requireJsonBody } from "../zbrowse/gateway/request-integrity.js";

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function request(headers = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    headers: normalized,
    get(name) {
      return normalized[name.toLowerCase()];
    }
  };
}

assert.equal(isJsonContentType("application/json"), true);
assert.equal(isJsonContentType("application/json; charset=utf-8"), true);
assert.equal(isJsonContentType(" Application/JSON ; charset=UTF-8"), true);
for (const value of [undefined, "", "text/plain", "application/x-www-form-urlencoded", "application/problem+json"]) {
  assert.equal(isJsonContentType(value), false, `expected ${String(value)} to be rejected`);
}

{
  const res = responseRecorder();
  let nextCalled = false;
  blockCrossSiteWrite(request({ "sec-fetch-site": "cross-site" }), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "Cross-site API requests are not allowed." });
}

for (const fetchSite of [undefined, "same-origin", "same-site", "none"]) {
  const headers = fetchSite ? { "sec-fetch-site": fetchSite } : {};
  const res = responseRecorder();
  let nextCalled = false;
  blockCrossSiteWrite(request(headers), res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, `expected ${String(fetchSite)} to pass`);
  assert.equal(res.statusCode, 200);
}

{
  const res = responseRecorder();
  let nextCalled = false;
  requireJsonBody(request({ "content-type": "text/plain" }), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 415);
  assert.deepEqual(res.body, { error: "Content-Type must be application/json." });
}

{
  const res = responseRecorder();
  let nextCalled = false;
  requireJsonBody(request({ "content-type": "application/json; charset=utf-8" }), res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
}

console.log("zBrowse request-integrity tests passed");
