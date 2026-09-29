# zGuard

zGuard is a small, privacy-first browser extension that blocks unwanted
script pop-ups, pop-unders and suspicious external tabs.

It is intended for Chromium browsers (Chrome, Edge, Brave, Opera) and Firefox.
The extension does not send browsing data to a server. Settings and counters
are stored locally in the browser.

## Features

- Blocks `window.open()` pop-ups and pop-unders.
- Blocks known unwanted domains: `al5sm.com`, `nap5k.com` and `tmll7.com`.
- Closes suspicious external tabs opened by a page as a fallback.
- Allows normal navigation within the current website.
- Two modes: **Gebalanceerd** and **Streng**.
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

## Privacy

zGuard has no analytics, remote API, account system or external network calls.
