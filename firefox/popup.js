(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const enabled = document.querySelector('#enabled');
  const count = document.querySelector('#count');
  const site = document.querySelector('#site');
  const status = document.querySelector('#status');
  const modeButtons = [...document.querySelectorAll('[data-mode]')];
  let settings = { enabled: true, mode: 'balanced', blockedCount: 0 };
  let ready = false;
  let saveFailed = false;
  let latestSave = 0;

  function showSite(tabs) {
    try {
      const target = new URL(tabs?.[0]?.url || '');
      site.textContent = ['https:', 'http:'].includes(target.protocol) && target.hostname
        ? target.hostname : 'Deze site';
    } catch (_) {
      site.textContent = 'Deze site';
    }
  }

  function render() {
    enabled.checked = settings.enabled;
    enabled.disabled = !ready;
    count.textContent = String(settings.blockedCount);
    status.textContent = !ready ? 'Instellingen niet beschikbaar' :
      saveFailed ? 'Opslaan mislukt' :
      settings.enabled ? 'Actief' : 'Uitgeschakeld';
    status.classList.toggle('off', !ready || saveFailed || !settings.enabled);
    modeButtons.forEach((button) => {
      button.disabled = !ready;
      button.classList.toggle('active', ready && button.dataset.mode === settings.mode);
    });
  }

  function acceptSettings(result) {
    if (!result || typeof result !== 'object' ||
        typeof result.enabled !== 'boolean' ||
        !['balanced', 'strict'].includes(result.mode) ||
        !Number.isSafeInteger(result.blockedCount) || result.blockedCount < 0) {
      return false;
    }
    settings = { enabled: result.enabled, mode: result.mode, blockedCount: result.blockedCount };
    ready = true;
    saveFailed = false;
    render();
    return true;
  }

  function commit(patch) {
    if (!ready) return Promise.resolve();
    const revision = ++latestSave;
    return save(patch).then((result) => {
      if (revision !== latestSave) return;
      if (!acceptSettings(result)) {
        saveFailed = true;
        render();
      }
    }).catch(() => {
      if (revision !== latestSave) return;
      saveFailed = true;
      render();
    });
  }

  render();
  const get = () => api.runtime.sendMessage({ type: 'get-settings' });
  const save = (patch) => api.runtime.sendMessage({ type: 'set-settings', settings: patch });
  api.tabs.query({ active: true, currentWindow: true }).then(showSite, () => showSite([]));

  get().then((result) => {
    if (!acceptSettings(result)) render();
  }).catch(() => render());
  enabled.addEventListener('change', () => commit({ enabled: enabled.checked }));
  modeButtons.forEach((button) => button.addEventListener('click',
    () => commit({ mode: button.dataset.mode })));
})();
