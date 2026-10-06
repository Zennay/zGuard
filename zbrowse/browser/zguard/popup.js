(function () {
  const api = globalThis.browser || globalThis.chrome;
  const enabled = document.querySelector('#enabled');
  const count = document.querySelector('#count');
  const site = document.querySelector('#site');
  const status = document.querySelector('#status');
  const modeButtons = [...document.querySelectorAll('[data-mode]')];
  let settings = { enabled: true, mode: 'balanced', blockedCount: 0 };

  const get = () => new Promise((resolve) => api.runtime.sendMessage({ type: 'get-settings' }, resolve));
  const save = (patch) => new Promise((resolve) => api.runtime.sendMessage({ type: 'set-settings', settings: patch }, resolve));
  function render() {
    enabled.checked = settings.enabled;
    count.textContent = String(settings.blockedCount || 0);
    status.textContent = settings.enabled ? 'Actief' : 'Uitgeschakeld';
    status.classList.toggle('off', !settings.enabled);
    modeButtons.forEach((button) => button.classList.toggle('active', button.dataset.mode === settings.mode));
  }
  function applySettings(result) {
    if (result && typeof result === 'object') {
      settings = { ...settings, ...result };
    }
    render();
  }
  api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    try {
      site.textContent = new URL(tabs?.[0]?.url || '').hostname || 'Deze site';
    } catch (_) {
      site.textContent = 'Deze site';
    }
  });
  get().then(applySettings).catch(render);
  enabled.addEventListener('change', () => save({ enabled: enabled.checked }).then(applySettings).catch(render));
  modeButtons.forEach((button) => button.addEventListener('click', () => save({ mode: button.dataset.mode }).then(applySettings).catch(render)));
})();
