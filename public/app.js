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
// Quartiers : la liste suit la ville choisie (sans JS, toutes les villes sont proposées et le serveur valide)
(function () {
  function build(sel, city) {
    var data = JSON.parse(sel.getAttribute('data-quartiers') || '{}'); var cur = sel.value;
    var cities = city ? [city] : Object.keys(data).filter(function (c) { return data[c].length > 1; });
    sel.innerHTML = ''; var o0 = document.createElement('option'); o0.value = ''; o0.textContent = sel.getAttribute('data-any') || ''; sel.appendChild(o0);
    var seen = {};
    cities.forEach(function (c) {
      (data[c] || []).forEach(function (g) {
        var label = g[0] ? (city ? g[0] : c + ' · ' + g[0]) : (city ? 'Autre' : null);
        if (!label) return;
        var og = document.createElement('optgroup'); og.label = label;
        g[1].forEach(function (n) { var o = document.createElement('option'); o.textContent = n; if (n === cur) { o.selected = true; } og.appendChild(o); });
        sel.appendChild(og);
      });
    });
    if (!city) { var og = document.createElement('optgroup'); og.label = 'Autre'; var o = document.createElement('option'); o.textContent = 'Autre quartier'; if (cur === 'Autre quartier') o.selected = true; og.appendChild(o); sel.appendChild(og); }
    if (sel.value !== cur) sel.value = '';
    sel.disabled = false;
  }
  document.querySelectorAll('select[data-qtarget]').forEach(function (city) {
    var q = document.getElementById(city.getAttribute('data-qtarget')); if (!q) return;
    city.addEventListener('change', function () { build(q, city.value); });
    if (city.value) build(q, city.value);
  });
})();
