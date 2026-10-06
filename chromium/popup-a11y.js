(function () {
  const buttons = [...document.querySelectorAll('[data-mode]')];
  if (!buttons.length) return;

  function syncPressedState() {
    buttons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.classList.contains('active')));
    });
  }

  const observer = new MutationObserver(syncPressedState);
  buttons.forEach((button) => {
    observer.observe(button, { attributes: true, attributeFilter: ['class'] });
  });
  syncPressedState();
})();
