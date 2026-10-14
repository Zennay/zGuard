(function () {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;
  const HOSTILE_HOSTS = new Set(['al5sm.com', 'nap5k.com', 'tmll7.com']);
  const DEFAULTS = { enabled: true, mode: 'balanced' };

  function send(event, detail) {
    try {
      api.runtime.sendMessage({ type: 'blocked-event', event, detail });
    } catch (_) {
      // The page may be unloading or the extension context may have reloaded.
    }
  }

  function hostOf(value) {
    try {
      return new URL(value, location.href).hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  }

  function isHostile(host) {
    return [...HOSTILE_HOSTS].some((known) => host === known || host.endsWith(`.${known}`));
  }

  function isExternal(value) {
    try {
      return new URL(value, location.href).origin !== location.origin;
    } catch (_) {
      return true;
    }
  }

  function shouldBlock(value, mode) {
    const host = hostOf(value);
    if (isHostile(host)) return true;
    if (!isExternal(value)) return false;
    return mode === 'strict';
  }

  // SVG <a> exposes SVGAnimatedString instead of the HTML anchor strings.
  // Normalize only known DOM string forms, never String([object SVGAnimatedString]).
  function linkValue(anchor, name) {
    const value = anchor[name];
    if (typeof value === 'string') return value;
    if (value && typeof value.baseVal === 'string') return value.baseVal;
    return '';
  }

  // Content scripts cannot rely on a one-time storage snapshot: settings
  // changes from the popup must take effect in already-open tabs. Subscribe
  // before hydrating storage, so events racing the async read are not lost.
  const liveSettings = { ...DEFAULTS };
  const changedDuringHydration = new Set();
  function validSetting(name, value) {
    if (name === 'enabled') return typeof value === 'boolean';
    return name === 'mode' && (value === 'balanced' || value === 'strict');
  }
  function applyStoredSettings(raw) {
    const stored = raw && typeof raw === 'object' ? raw : {};
    for (const name of ['enabled', 'mode']) {
      if (changedDuringHydration.has(name)) continue;
      if (validSetting(name, stored[name])) liveSettings[name] = stored[name];
    }
  }
  // One-way, capability-free bridge to the separate MAIN-world script.
  // Only public boolean/mode values cross the page boundary. Never accept
  // page events as commands or forward them to privileged extension APIs.
  function announcePagePolicy() {
    try {
      document.dispatchEvent(new CustomEvent('zguard:policy-v1', {
        detail: JSON.stringify({
          enabled: liveSettings.enabled, mode: liveSettings.mode
        })
      }));
    } catch (_) {
      // The page can be unloading or the DOM environment may be unavailable.
    }
  }

  try {
    api.storage.onChanged?.addListener?.((changes, namespace) => {
      if (namespace !== 'local' || !changes || typeof changes !== 'object') return;
      for (const name of ['enabled', 'mode']) {
        if (!Object.prototype.hasOwnProperty.call(changes, name)) continue;
        const value = changes[name]?.newValue;
        if (!validSetting(name, value)) continue;
        changedDuringHydration.add(name);
        liveSettings[name] = value;
      }
      announcePagePolicy();
    });
  } catch (_) {
    // A disabled extension context may lose its storage event API.
  }

  function currentSettings() {
    return new Promise((resolve) => {
      try {
        api.storage.local.get(DEFAULTS, (result) => resolve({ ...DEFAULTS, ...result }));
      } catch (_) {
        resolve(DEFAULTS);
      }
    });
  }

  currentSettings().then((stored) => {
    applyStoredSettings(stored);
    announcePagePolicy();

    const originalOpen = window.open;
    window.open = function zGuardWindowOpen(url, target, features) {
      if (liveSettings.enabled && shouldBlock(url || '', liveSettings.mode)) {
        send('window-open', { url: String(url || ''), mode: liveSettings.mode });
        return null;
      }
      return originalOpen.call(window, url, target, features);
    };

    const interceptPopupLink = (event) => {
      if (event.type === 'auxclick' && event.button !== 1) return;
      // Document capture retargets open-shadow-root clicks to their host.
      // Composed paths retain the inner link without crossing closed roots.
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      let anchor = null;
      for (const node of [...path, event.target]) {
        if (!node || typeof node.closest !== 'function') continue;
        anchor = node.closest('a,area');
        if (anchor) break;
      }
      if (!anchor) return;
      const href = linkValue(anchor, 'href');
      const target = linkValue(anchor, 'target');
      if (!href) return;
      const newTab = target.toLowerCase() === '_blank' || event.ctrlKey || event.metaKey || event.button === 1;
      if (!newTab || !liveSettings.enabled || !shouldBlock(href, liveSettings.mode)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      send('external-link', { url: href, mode: liveSettings.mode });
    };
    document.addEventListener('click', interceptPopupLink, true);
    // Native middle-button release dispatches auxclick, not click.
    document.addEventListener('auxclick', interceptPopupLink, true);

    // requestSubmit() and trusted form-submit gestures bypass anchor clicks.
    // Respect the effective submitter's formtarget/formaction overrides.
    document.addEventListener('submit', (event) => {
      const form = event.target;
      if (!form || form.tagName !== 'FORM') return;
      const submitter = event.submitter;
      const override = (name) => Boolean(submitter &&
        typeof submitter.hasAttribute === 'function' && submitter.hasAttribute(name));
      const target = override('formtarget') ? submitter.formTarget : form.target;
      const action = override('formaction') ? submitter.formAction : form.action;
      if (String(target).toLowerCase() !== '_blank' || !liveSettings.enabled ||
          !shouldBlock(action || '', liveSettings.mode)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      send('external-link', { url: String(action || ''), mode: liveSettings.mode });
    }, true);
  });
})();
