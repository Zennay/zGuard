# zBrowse portal network source-contract: aliases

The public portal code in `zbrowse/gateway/public/app.js` is intentionally small and has a single reviewed `request(url, options)` function. Every normal HTTP API request must call that helper with a literal same-origin `/api/` path; the one `navigator.sendBeacon()` on pagehide must also target a literal `/api/` path.

## What the quality gate enforces

The source-only regression test `tests/zbrowse.portal-network-boundary.test.mjs` counts the direct `fetch()` call **and all `fetch` token references**. These counts must match (exactly one direct call). This rejects second requests made through `window.fetch`, `globalThis.fetch`, destructuring and literal computed-property aliases while preserving the reviewed wrapper.

Similarly, every `sendBeacon` token must be part of a direct `navigator.sendBeacon()` call. Any appearance of `XMLHttpRequest`, `WebSocket`, or `EventSource` in the portal source fails the review even if it appears only in an alias assignment instead of a constructor call. Adversarial self-tests keep these failure patterns observable.

This is a deliberately conservative **source review contract** for a small fixed JavaScript file, not a complete JavaScript parser, sandbox, CSP, network egress firewall or proof against dynamically generated/obfuscated names. Source refactors that legitimately introduce new network APIs require deliberate review and contract changes; no live portal/runtime changes are made here.

Issue: https://github.com/Zennay/zGuard/issues/255
