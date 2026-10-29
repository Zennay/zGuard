// Runs only in Chromium's unprivileged MAIN world. Never import extension
// APIs, accept commands, or send credentials from untrusted page JavaScript.
// A page can tamper with its own world; the background tab guard remains the
// independent browser-level defense against those attempts.
(() => {
  'use strict';
  const blockedHosts = new Set(['al5sm.com', 'nap5k.com', 'tmll7.com']);
  const state = { enabled: true, mode: 'balanced' };

  function shouldBlock(raw) {
    try {
      const url = new URL(raw || '', location.href);
      const hostname = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
      const hostile = [...blockedHosts].some(host =>
        hostname === host || hostname.endsWith('.' + host));
      if (hostile) return true;
      if (url.origin === location.origin) return false;
      return state.mode === 'strict';
    } catch (_) {
      // Do not interpret malformed inputs as an authorized foreign host.
      return state.mode === 'strict';
    }
  }

  // Configuration is deliberately non-privileged and page-interferable:
  // changing these DOM events cannot request extension capabilities. The
  // isolated content script only emits the fixed enabled/mode schema.
  document.addEventListener('zguard:policy-v1', (event) => {
    if (typeof event.detail !== 'string' || event.detail.length > 96) return;
    let config;
    try { config = JSON.parse(event.detail); } catch (_) { return; }
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        Object.keys(config).sort().join(',') !== 'enabled,mode' ||
        typeof config.enabled !== 'boolean' ||
        !['balanced', 'strict'].includes(config.mode)) return;
    state.enabled = config.enabled;
    state.mode = config.mode;
  }, true);

  const originalOpen = window.open;
  if (typeof originalOpen !== 'function') return;
  window.open = function zGuardWindowOpen(url, target, features) {
    if (state.enabled && shouldBlock(url)) return null;
    return originalOpen.call(window, url, target, features);
  };
})();
