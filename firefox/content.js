(function () {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;
  const HOSTILE_HOSTS = new Set(['al5sm.com', 'nap5k.com', 'tmll7.com']);
  const DEFAULTS = { enabled: true, mode: 'balanced' };

  function normalizeSettings(value = {}) {
    const merged = { ...DEFAULTS, ...(value && typeof value === 'object' ? value : {}) };
    return {
      enabled: typeof merged.enabled === 'boolean' ? merged.enabled : DEFAULTS.enabled,
      mode: merged.mode === 'strict' || merged.mode === 'balanced' ? merged.mode : DEFAULTS.mode
    };
  }

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

  let settings = { ...DEFAULTS };
  let settingsReady = false;
  let settingsRevision = 0;

  api.storage.local.get(DEFAULTS).then(normalizeSettings).then((current) => {
    if (settingsRevision === 0) settings = current;
    settingsReady = true;
  });

  api.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(changes, 'enabled')) {
      patch.enabled = changes.enabled?.newValue;
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'mode')) {
      patch.mode = changes.mode?.newValue;
    }
    if (Object.keys(patch).length === 0) return;
    settingsRevision += 1;
    settings = normalizeSettings({ ...settings, ...patch });
    settingsReady = true;
  });

  const originalOpen = window.open;
  window.open = function zGuardWindowOpen(url, target, features) {
    if (settingsReady && settings.enabled && shouldBlock(url || '', settings.mode)) {
      send('window-open', { url: String(url || ''), mode: settings.mode });
      return null;
    }
    return originalOpen.call(window, url, target, features);
  };

  document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a') : null;
    if (!anchor || !anchor.href || !settingsReady || !settings.enabled) return;
    const newTab = anchor.target === '_blank' || event.ctrlKey || event.metaKey || event.button === 1;
    if (!newTab || !shouldBlock(anchor.href, settings.mode)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send('external-link', { url: anchor.href, mode: settings.mode });
  }, true);
})();
