(function () {
  function clearFactsClientState() {
    try { localStorage.clear(); } catch (e) { /* storage may be blocked */ }
    try { sessionStorage.clear(); } catch (e) { /* storage may be blocked */ }
  }

  async function factsLogout(loginPath) {
    clearFactsClientState();
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (e) { /* still leave the page */ }
    window.location.replace(loginPath || '/login');
  }

  window.factsLogout = factsLogout;
  window.clearFactsClientState = clearFactsClientState;

  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.authenticated) window.location.replace('/login');
      })
      .catch(function () { window.location.replace('/login'); });
  });
}());
