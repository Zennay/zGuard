const api = globalThis.browser || globalThis.chrome;
const DEFAULTS = {
  enabled: true,
  mode: 'balanced',
  blockedCount: 0,
  lastBlocked: null
};
const HOSTILE_HOSTS = ['al5sm.com', 'nap5k.com', 'tmll7.com'];

function normalizeSettings(value = {}) {
  const merged = { ...DEFAULTS, ...(value && typeof value === 'object' ? value : {}) };
  return {
    enabled: typeof merged.enabled === 'boolean' ? merged.enabled : DEFAULTS.enabled,
    mode: merged.mode === 'strict' || merged.mode === 'balanced' ? merged.mode : DEFAULTS.mode,
    blockedCount: Number.isSafeInteger(merged.blockedCount) && merged.blockedCount >= 0
      ? merged.blockedCount
      : DEFAULTS.blockedCount,
    lastBlocked: merged.lastBlocked && typeof merged.lastBlocked === 'object'
      ? merged.lastBlocked
      : DEFAULTS.lastBlocked
  };
}

function applySettingsPatch(current, patch) {
  const next = { ...current };
  if (typeof patch?.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch?.mode === 'balanced' || patch?.mode === 'strict') next.mode = patch.mode;
  return normalizeSettings(next);
}

function hostOf(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; }
}
function hostile(value) {
  const host = hostOf(value);
  return HOSTILE_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}
function external(value, opener) {
  try { return new URL(value).origin !== new URL(opener).origin; } catch (_) { return true; }
}
function getSettings() {
  return new Promise((resolve) => api.storage.local.get(DEFAULTS, (r) => resolve(normalizeSettings(r))));
}
function set(data) {
  return new Promise((resolve) => api.storage.local.set(data, resolve));
}

api.runtime.onInstalled.addListener(() => api.storage.local.get(DEFAULTS, (current) => {
  api.storage.local.set(normalizeSettings(current));
}));

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'blocked-event') {
    getSettings().then((settings) => set({
      blockedCount: settings.blockedCount + 1,
      lastBlocked: { event: message.event, detail: message.detail || null, at: new Date().toISOString() }
    }));
    return false;
  }
  if (message?.type === 'get-settings') {
    getSettings().then(sendResponse);
    return true;
  }
  if (message?.type === 'set-settings') {
    getSettings().then((current) => {
      const next = applySettingsPatch(current, message.settings);
      return set(next).then(() => sendResponse(next));
    });
    return true;
  }
  return false;
});

api.tabs.onCreated.addListener(async (tab) => {
  const settings = await getSettings();
  if (!settings.enabled || !tab.url || !tab.openerTabId) return;
  let opener;
  try { opener = await api.tabs.get(tab.openerTabId); } catch (_) { return; }
  const shouldClose = hostile(tab.url) || (settings.mode === 'strict' && external(tab.url, opener.url || ''));
  if (!shouldClose) return;
  try {
    await api.tabs.remove(tab.id);
    await set({
      blockedCount: settings.blockedCount + 1,
      lastBlocked: { event: 'new-tab', detail: { url: tab.url }, at: new Date().toISOString() }
    });
  } catch (_) {}
});
