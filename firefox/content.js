(function () {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;
  const HOSTILE_HOSTS = new Set(['al5sm.com', 'nap5k.com', 'tmll7.com']);
  const DEFAULTS = { enabled: true, mode: 'balanced' };

  function send(event, detail) {
    try { api.runtime.sendMessage({ type: 'blocked-event', event, detail }); } catch (_) {}
  }
  function hostOf(value) {
    try { return new URL(value, location.href).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; }
  }
  function isHostile(host) {
    return [...HOSTILE_HOSTS].some((known) => host === known || host.endsWith(`.${known}`));
  }
  function isExternal(value) {
    try { return new URL(value, location.href).origin !== location.origin; } catch (_) { return true; }
  }
  function shouldBlock(value, mode) {
    const host = hostOf(value);
    if (isHostile(host)) return true;
    if (!isExternal(value)) return false;
    return mode === 'strict';
  }

  api.storage.local.get(DEFAULTS).then(({ enabled, mode }) => {
    if (!enabled) return;
    const originalOpen = window.open;
    window.open = function zGuardWindowOpen(url, target, features) {
      if (shouldBlock(url || '', mode)) {
        send('window-open', { url: String(url || ''), mode });
        return null;
      }
      return originalOpen.call(window, url, target, features);
    };
    document.addEventListener('click', (event) => {
      const anchor = event.target && event.target.closest ? event.target.closest('a') : null;
      if (!anchor || !anchor.href) return;
      const newTab = anchor.target === '_blank' || event.ctrlKey || event.metaKey || event.button === 1;
      if (!newTab || !shouldBlock(anchor.href, mode)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      send('external-link', { url: anchor.href, mode });
    }, true);
  });
})();
