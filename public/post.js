// Formulaire dépôt / modification : aperçu + redimensionnement côté client (économie de données)
(function () {
  var MAXDIM = 1280, QUALITY = 0.8;
  var form = document.getElementById('postf'), input = document.getElementById('photos'),
      box = document.getElementById('previews'), msg = document.getElementById('formmsg'), btn = document.getElementById('submitb');
  var MAX = +form.dataset.max || 6, label = btn.textContent;
  var files = []; // {blob, url}
  function keptExisting() { return form.querySelectorAll('.pv.old').length - form.querySelectorAll('.pv.old input:checked').length; }

  function resize(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var s = Math.min(1, MAXDIM / Math.max(img.width, img.height));
        var c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        c.toBlob(function (b) { resolve(b || file); }, 'image/jpeg', QUALITY);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  function render() {
    box.innerHTML = '';
    files.forEach(function (f, i) {
      var d = document.createElement('div'); d.className = 'pv';
      d.innerHTML = '<img alt="">' + (i === 0 && keptExisting() === 0 ? '<span class="first">Principale</span>' : '') + '<button type="button" aria-label="Retirer">×</button>';
      d.querySelector('img').src = f.url;
      d.querySelector('button').onclick = function () { URL.revokeObjectURL(f.url); files.splice(i, 1); render(); };
      box.appendChild(d);
    });
  }
  input.addEventListener('change', async function () {
    var list = Array.prototype.slice.call(input.files), room = MAX - keptExisting() - files.length;
    if (list.length > room) { alert('Maximum ' + MAX + ' photos au total.'); list = list.slice(0, Math.max(0, room)); }
    msg.textContent = 'Préparation des photos…';
    for (var i = 0; i < list.length; i++) {
      if (!/^image\//.test(list[i].type)) continue;
      var b = await resize(list[i]); if (b) files.push({ blob: b, url: URL.createObjectURL(b) });
    }
    input.value = ''; msg.textContent = ''; render();
  });
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    form.querySelectorAll('.err').forEach(function (n) { n.remove(); });
    var fd = new FormData(form); fd.delete('photos');
    files.forEach(function (f, i) { fd.append('photos', f.blob, 'photo' + (i + 1) + '.jpg'); });
    btn.disabled = true; btn.textContent = 'Envoi en cours…'; msg.textContent = '';
    try {
      var r = await fetch(form.action, { method: 'POST', body: fd, headers: { Accept: 'application/json' } });
      if (r.status === 401) { location.href = '/connexion?next=' + encodeURIComponent(location.pathname); return; }
      var j = await r.json();
      if (j.ok) { location.href = j.url; return; }
      Object.keys(j.errors || {}).forEach(function (k) {
        if (k === '_') { msg.textContent = j.errors[k]; return; }
        var el = form.querySelector('[name="' + k + '"]') || input;
        var s = document.createElement('span'); s.className = 'err js'; s.textContent = j.errors[k];
        (el.closest('label') || el.parentNode).appendChild(s);
      });
      var first = form.querySelector('.err'); if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) { msg.textContent = 'Connexion impossible. Vérifiez votre réseau et réessayez.'; }
    btn.disabled = false; btn.textContent = label;
  });
})();
