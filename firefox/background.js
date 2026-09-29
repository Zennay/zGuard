const api = globalThis.browser || globalThis.chrome;
const DEFAULTS = { enabled: true, mode: 'balanced', blockedCount: 0, lastBlocked: null };
const HOSTILE_HOSTS = ['al5sm.com', 'nap5k.com', 'tmll7.com'];
const hostOf = (value) => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; } };
const hostile = (value) => { const host = hostOf(value); return HOSTILE_HOSTS.some((known) => host === known || host.endsWith(`.${known}`)); };
const external = (value, opener) => { try { return new URL(value).origin !== new URL(opener).origin; } catch (_) { return true; } };
const getSettings = () => api.storage.local.get(DEFAULTS).then((r) => ({ ...DEFAULTS, ...r }));
const set = (data) => api.storage.local.set(data);

api.runtime.onInstalled.addListener(() => api.storage.local.get(DEFAULTS).then((current) => set({ ...DEFAULTS, ...current })));
api.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'blocked-event') return getSettings().then((settings) => set({
    blockedCount: settings.blockedCount + 1,
    lastBlocked: { event: message.event, detail: message.detail || null, at: new Date().toISOString() }
  }));
  if (message?.type === 'get-settings') return getSettings();
  if (message?.type === 'set-settings') return set(message.settings || {}).then(getSettings);
  return false;
});

api.tabs.onCreated.addListener(async (tab) => {
  const settings = await getSettings();
  if (!settings.enabled || !tab.url || !tab.openerTabId) return;
  let opener; try { opener = await api.tabs.get(tab.openerTabId); } catch (_) { return; }
  if (!(hostile(tab.url) || (settings.mode === 'strict' && external(tab.url, opener.url || '')))) return;
  try {
    await api.tabs.remove(tab.id);
    await set({ blockedCount: settings.blockedCount + 1, lastBlocked: { event: 'new-tab', detail: { url: tab.url }, at: new Date().toISOString() } });
  } catch (_) {}
});
