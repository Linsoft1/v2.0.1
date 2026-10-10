(() => {
  const url = new URL(location.href);
  if (url.origin !== 'https://linsoft.ddns.net' || url.pathname !== '/linsoft-search/' || !url.searchParams.get('q')?.trim()) return;

  // Session preloads run before page scripts and the first rendered search form.
  const style = document.createElement('style');
  style.textContent = '#home-view { visibility: hidden !important; }';
  let timeout;
  const restore = () => {
    observer.disconnect();
    clearTimeout(timeout);
    style.remove();
  };
  const observer = new MutationObserver(() => {
    if (!style.isConnected && document.documentElement) document.documentElement.append(style);
    if (document.getElementById('home-view')?.classList.contains('hidden')) restore();
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  if (document.documentElement) document.documentElement.append(style);
  timeout = setTimeout(() => {
    restore();
    const message = document.createElement('p');
    message.setAttribute('role', 'alert');
    message.textContent = 'Linsoft Search sa nepodarilo spustiť. Skús vyhľadávanie znova.';
    (document.getElementById('home-view') || document.body)?.prepend(message);
    console.error('Linsoft Search did not enter the results view; restoring its search form.');
  }, 15000);
})();
