(function () {
  const api = globalThis.browser || globalThis.chrome;
  const enabled = document.querySelector('#enabled'); const count = document.querySelector('#count'); const site = document.querySelector('#site'); const status = document.querySelector('#status'); const modeButtons = [...document.querySelectorAll('[data-mode]')];
  let settings = { enabled: true, mode: 'balanced', blockedCount: 0 };
  const get = () => api.runtime.sendMessage({ type: 'get-settings' }); const save = (patch) => api.runtime.sendMessage({ type: 'set-settings', settings: patch });
  function render() { enabled.checked = settings.enabled; count.textContent = String(settings.blockedCount || 0); status.textContent = settings.enabled ? 'Actief' : 'Uitgeschakeld'; status.classList.toggle('off', !settings.enabled); modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === settings.mode)); }
  api.tabs.query({ active: true, currentWindow: true }).then((tabs) => { try { site.textContent = new URL(tabs?.[0]?.url || '').hostname || 'Deze site'; } catch (_) {} });
  get().then((result) => { if (result) settings = result; render(); });
  enabled.addEventListener('change', () => save({ enabled: enabled.checked }).then((result) => { settings = result; render(); }));
  modeButtons.forEach((b) => b.addEventListener('click', () => save({ mode: b.dataset.mode }).then((result) => { settings = result; render(); })));
})();
