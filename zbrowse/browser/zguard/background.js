const api = globalThis.browser || globalThis.chrome;
const DEFAULTS = {
  enabled: true,
  mode: 'balanced',
  blockedCount: 0,
  lastBlocked: null
};
const HOSTILE_HOSTS = ['al5sm.com', 'nap5k.com', 'tmll7.com'];

function hostOf(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, ''); } catch (_) { return ''; }
}
function hostile(value) {
  const host = hostOf(value);
  return HOSTILE_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}
function external(value, opener) {
  try { return new URL(value).origin !== new URL(opener).origin; } catch (_) { return true; }
}
function safeBlockedDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const safe = {};
  if (detail.mode === 'balanced' || detail.mode === 'strict') safe.mode = detail.mode;
  if (typeof detail.url === 'string') {
    try {
      const parsed = new URL(detail.url);
      safe.url = parsed.protocol === 'https:' || parsed.protocol === 'http:'
        ? parsed.origin : '[redacted]';
    } catch (_) {
      safe.url = '[redacted]';
    }
  }
  return safe;
}
function safeBlockedHistory(history) {
  if (!history || typeof history !== 'object') return null;
  const allowed = ['new-tab', 'window-open', 'external-link'];
  return {
    event: allowed.includes(history.event) ? history.event : 'blocked',
    detail: safeBlockedDetail(history.detail),
    at: typeof history.at === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(history.at)
      ? history.at : new Date().toISOString()
  };
}
function normalizeSettings(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULTS.enabled,
    mode: v.mode === 'strict' || v.mode === 'balanced' ? v.mode : DEFAULTS.mode,
    blockedCount: Number.isSafeInteger(v.blockedCount) && v.blockedCount >= 0
      ? v.blockedCount : DEFAULTS.blockedCount,
    lastBlocked: safeBlockedHistory(v.lastBlocked)
  };
}
function applySettingsPatch(settings, input) {
  const next = { ...settings };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (typeof input.enabled === 'boolean') next.enabled = input.enabled;
    if (input.mode === 'balanced' || input.mode === 'strict') next.mode = input.mode;
  }
  return next;
}
let storageQueue = Promise.resolve();
function mutateSettings(update) {
  const operation = storageQueue.then(async () => {
    const settings = await getSettings();
    const next = normalizeSettings(update(settings));
    await set(next);
    return next;
  });
  storageQueue = operation.then(() => undefined, () => undefined);
  return operation;
}
function getSettings() {
  return new Promise((resolve, reject) => {
    api.storage.local.get(DEFAULTS, (value) => {
      if (api.runtime.lastError) return reject(new Error('Storage read unavailable'));
      resolve(normalizeSettings(value));
    });
  });
}
function set(data) {
  return new Promise((resolve, reject) => {
    api.storage.local.set(data, () => {
      if (api.runtime.lastError) return reject(new Error('Storage write unavailable'));
      resolve();
    });
  });
}

api.runtime.onInstalled.addListener(() => mutateSettings((settings) => settings).catch(() => null));

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'blocked-event') {
    void mutateSettings((settings) => ({
      ...settings,
      blockedCount: settings.blockedCount + 1,
      lastBlocked: { event: message.event, detail: safeBlockedDetail(message.detail), at: new Date().toISOString() }
    })).catch(() => null);
    return false;
  }
  if (message?.type === 'get-settings') {
    storageQueue.then(getSettings).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (message?.type === 'set-settings') {
    mutateSettings((settings) => applySettingsPatch(settings, message.settings)).then(sendResponse, () => sendResponse(null));
    return true;
  }
  return false;
});

api.tabs.onCreated.addListener(async (tab) => {
  let settings;
  try { settings = await storageQueue.then(getSettings); } catch (_) { return; }
  const targetUrl = tab.url || tab.pendingUrl;
  if (!settings.enabled || !targetUrl || !tab.openerTabId) return;
  // Browser-internal/opaque targets are not web popup destinations.
  // In particular, do not interpret about:blank as foreign in Strict mode.
  try {
    if (!['https:', 'http:'].includes(new URL(targetUrl).protocol)) return;
  } catch (_) { return; }
  let opener;
  try { opener = await api.tabs.get(tab.openerTabId); } catch (_) { return; }
  const shouldClose = hostile(targetUrl) || (settings.mode === 'strict' && external(targetUrl, opener.url || ''));
  if (!shouldClose) return;
  try {
    await api.tabs.remove(tab.id);
    await mutateSettings((current) => ({
      ...current,
      blockedCount: current.blockedCount + 1,
      lastBlocked: { event: 'new-tab', detail: safeBlockedDetail({ url: targetUrl }), at: new Date().toISOString() }
    }));
  } catch (_) {}
});
