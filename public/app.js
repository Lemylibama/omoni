// Améliorations légères : favoris sans rechargement, fermeture du menu compte
(function () {
  document.addEventListener('submit', function (e) {
    var f = e.target; if (!f.classList || !f.classList.contains('fav-f')) return;
    e.preventDefault();
    var b = f.querySelector('button');
    fetch(f.action, { method: 'POST', body: new URLSearchParams(new FormData(f)), headers: { Accept: 'application/json' } })
      .then(function (r) { if (r.status === 401) { location.href = '/connexion?next=' + encodeURIComponent(location.pathname + location.search); return null; } return r.json(); })
      .then(function (j) { if (!j || !j.ok) return; b.classList.toggle('on', j.fav); b.textContent = j.fav ? '♥' : '♡'; b.setAttribute('aria-pressed', j.fav); b.setAttribute('aria-label', j.fav ? 'Retirer des favoris' : 'Ajouter aux favoris'); })
      .catch(function () { f.submit(); });
  });
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.menu[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });
})();
