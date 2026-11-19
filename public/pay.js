// Paiement : sélection opérateur -> indice ; page d'attente -> interrogation du statut toutes les 4 s
(function () {
  var f = document.getElementById('boostf');
  if (f) {
    var hint = document.getElementById('ophint'), btn = document.getElementById('paybtn');
    var upd = function () {
      var p = f.querySelector('input[name=product]:checked'), o = f.querySelector('input[name=operator]:checked');
      if (p) btn.textContent = 'Payer ' + Number(p.dataset.price).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ') + ' FCFA' + (o ? (o.value === 'mtn' ? ' avec MTN MoMo' : ' avec Airtel Money') : '');
      if (o) hint.textContent = o.value === 'mtn' ? 'Numéro MTN : commence par 06' : 'Numéro Airtel : commence par 05 ou 04';
    };
    f.addEventListener('change', upd); upd();
    f.addEventListener('submit', function () { btn.disabled = true; btn.textContent = 'Envoi de la demande…'; });
  }
  var w = document.getElementById('paywait');
  if (w && window.fetch) {
    var ref = w.dataset.ref, end = Date.now() + (+w.dataset.left || 0), cd = document.getElementById('countdown');
    setInterval(function () { var s = Math.max(0, Math.round((end - Date.now()) / 1000)); if (cd) cd.textContent = Math.floor(s / 60) + ' min ' + ('0' + (s % 60)).slice(-2) + ' s'; }, 1000);
    setInterval(function () {
      if (document.hidden) return;
      fetch('/paiements/' + ref + '/statut', { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); })
        .then(function (j) { if (j.ok && j.status !== 'pending') location.reload(); }).catch(function () {});
    }, 4000);
  }
})();
