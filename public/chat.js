// Conversation : envoi sans rechargement + actualisation légère toutes les 10 s (page visible uniquement)
(function () {
  var chat = document.getElementById('chat'); if (!chat || !window.fetch) return;
  var box = document.getElementById('bubbles'), form = document.getElementById('sendf'), info = document.getElementById('chatmsg');
  var conv = chat.dataset.conv, last = +chat.dataset.last || 0, busy = false;
  function add(m) {
    if (m.id <= last) return; last = m.id;
    var empty = box.querySelector('p.muted'); if (empty) empty.remove();
    var d = document.createElement('div'); d.className = 'bubble ' + (m.mine ? 'me' : 'them'); d.dataset.id = m.id;
    var t = document.createElement('div'); t.className = 'btext'; t.textContent = m.body;
    var h = document.createElement('div'); h.className = 'btime'; h.textContent = m.time;
    d.appendChild(t); d.appendChild(h); box.appendChild(d);
  }
  function bottom() { box.lastElementChild && box.lastElementChild.scrollIntoView({ block: 'end' }); }
  function setBadge(n) { var b = document.getElementById('hdr-unread'); if (b) { if (n > 0) b.textContent = n; else b.remove(); } }
  function poll() {
    if (busy || document.hidden) return; busy = true;
    fetch('/messages/' + conv + '/nouveaux?apres=' + last, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.ok) { var had = last; j.messages.forEach(add); if (last > had) bottom(); setBadge(j.unread); } })
      .catch(function () {}).then(function () { busy = false; });
  }
  setInterval(poll, 10000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  bottom(); setBadge(0);
  if (form) {
    var ta = form.querySelector('textarea');
    form.addEventListener('submit', function (e) {
      e.preventDefault(); var text = ta.value.trim(); if (!text) return;
      var btn = form.querySelector('button'); btn.disabled = true;
      fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.ok) { ta.value = ''; add(j.message); bottom(); info.textContent = 'Actualisation automatique toutes les 10 secondes.'; info.classList.remove('err'); }
          else { info.textContent = j.error || 'Envoi impossible.'; info.classList.add('err'); }
        })
        .catch(function () { info.textContent = 'Connexion impossible. Réessayez.'; info.classList.add('err'); })
        .then(function () { btn.disabled = false; });
    });
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
  }
})();
