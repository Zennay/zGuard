const api = globalThis.browser || globalThis.chrome;
const DEFAULTS = {
  enabled: true,
  mode: 'balanced',
  blockedCount: 0,
  lastBlocked: null
};
const HOSTILE_HOSTS = ['al5sm.com', 'nap5k.com', 'tmll7.com'];

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
  return new Promise((resolve) => api.storage.local.get(DEFAULTS, (r) => resolve({ ...DEFAULTS, ...r })));
}
function set(data) {
  return new Promise((resolve) => api.storage.local.set(data, resolve));
}

api.runtime.onInstalled.addListener(() => api.storage.local.get(DEFAULTS, (current) => {
  api.storage.local.set({ ...DEFAULTS, ...current });
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
    set(message.settings || {}).then(() => getSettings().then(sendResponse));
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
