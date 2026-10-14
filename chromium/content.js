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

  function currentSettings() {
    return new Promise((resolve) => {
      try {
        api.storage.local.get(DEFAULTS, (result) => resolve({ ...DEFAULTS, ...result }));
      } catch (_) {
        resolve(DEFAULTS);
      }
    });
  }

  currentSettings().then(({ enabled, mode }) => {
    if (!enabled) return;

    const originalOpen = window.open;
    window.open = function zGuardWindowOpen(url, target, features) {
      if (shouldBlock(url || '', mode)) {
        send('window-open', { url: String(url || ''), mode });
        return null;
      }
      return originalOpen.call(window, url, target, features);
    };

    const interceptPopupLink = (event) => {
      if (event.type === 'auxclick' && event.button !== 1) return;
      const anchor = event.target && event.target.closest ? event.target.closest('a,area') : null;
      if (!anchor) return;
      const href = linkValue(anchor, 'href');
      const target = linkValue(anchor, 'target');
      if (!href) return;
      const newTab = target === '_blank' || event.ctrlKey || event.metaKey || event.button === 1;
      if (!newTab || !shouldBlock(href, mode)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      send('external-link', { url: href, mode });
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
      if (String(target).toLowerCase() !== '_blank' || !shouldBlock(action || '', mode)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      send('external-link', { url: String(action || ''), mode });
    }, true);
  });
})();
