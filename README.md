# zGuard

zGuard is a small, privacy-first browser extension that blocks unwanted
script pop-ups, pop-unders and suspicious external tabs.

It is intended for Chromium browsers (Chrome, Edge, Brave, Opera) and Firefox.
The extension does not send browsing data to a server. Settings and counters
are stored locally in the browser.

## Features

- Applies popup-blocking decisions to extension-observable script/new-tab events.
- Blocks known unwanted domains: `al5sm.com`, `nap5k.com` and `tmll7.com`.
- Uses browser-level new-tab handling as a defense-in-depth fallback when a usable target URL is available.
- Allows normal navigation within the current website.
- Two modes: **Gebalanceerd** blocks known hostile popup domains while allowing ordinary external opens; **Streng** additionally blocks qualifying external new-tab/pop-up opens.
- Site profiles for SerienStream and Fawesome.
- Local-only blocked-event counters.

Video advertising that is rendered inside a legitimate stream is outside the
scope of this extension and may still appear.

## Install on Chrome / Edge / Brave / Opera

1. Download or clone this repository.
2. Open `chrome://extensions` (or the equivalent extensions page).
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the `chromium/` folder.
6. Pin zGuard to the browser toolbar.

## Install on Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `firefox/manifest.json`.

Firefox temporary add-ons are removed when Firefox restarts. A permanent
Firefox install requires signing the add-on through Mozilla Add-ons.

## Development

There are no build dependencies. The `chromium/` and `firefox/` directories
are directly loadable extension packages. Run the smoke tests with:

```bash
node tests/smoke.test.js
```

The smoke gate also executes behavior coverage for the balanced/strict decision semantics.

### CI merge gate

`zGuard quality validation` is the portable merge gate for pull requests. It runs on
`ubuntu-latest` and keeps the extension smoke suite, zBrowse runtime contracts,
locked production install, and high-severity production dependency audit in one
terminal check.

Runner evidence only counts for the exact pull-request head commit: the workflow
run's `head_sha` must equal the PR `head_sha`. A green run for an older commit is
not merge evidence after the branch moves.

Portable validation must not use an unlabelled generic `self-hosted` runner. When
real VPS-specific proof is required, use an explicit exact-ref route labelled for
the permanent zCloud VPS runner (for example `[self-hosted, zcloud, vps]`) and keep
that verification read-only: no deploy, service restart, or production mutation.

## Quality status

The Node/VM smoke suite proves decision logic and package consistency, but it is not
browser-realistic proof that page-authored JavaScript is intercepted in the page's
MAIN JavaScript world. That integration gap is tracked in
[issue #3](https://github.com/Zennay/zGuard/issues/3).

The browser-level new-tab fallback also still needs explicit `pendingUrl` coverage
before it can be treated as complete for pre-commit navigations; that gate is tracked
in [issue #9](https://github.com/Zennay/zGuard/issues/9).

Until those gates are closed with real-browser evidence, zGuard should be described as
a popup-blocking prototype with tested decision logic rather than a complete bypass-proof
popup blocker.

For zBrowse runtime validation and deployment checks, see [`zbrowse/README.md`](zbrowse/README.md).

## Privacy

zGuard has no analytics, remote API, account system or external network calls.
