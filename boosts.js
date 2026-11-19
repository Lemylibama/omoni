// Boosts payants (Remonter, À la une, Urgent) payés par MTN MoMo / Airtel Money
const crypto = require('crypto');
const express = require('express');
const auth = require('./auth');
const pay = require('./payments');

module.exports = function mountBoosts(app, h) {
  const { db, C, esc, layout, page, csrfField, fmtPrice, fmtDate, fmtDay, fmtPhone, normPhone, photoUrl, firstPhotoStmt, audit, requireUser, catBySlug, DAY } = h;
  const TTL = (C.PAYMENT_TTL_MIN || 10) * 60000;
  const ST = { pending: 'En attente', success: 'Payé', failed: 'Échoué', expired: 'Expiré', refunded: 'Remboursé' };
  const STC = { pending: 'st-wait', success: 'st-ok', failed: 'st-bad', expired: 'st-sold', refunded: 'st-sold' };
  const products = (all = false) => db.prepare(`SELECT * FROM boost_products ${all ? '' : 'WHERE active = 1'} ORDER BY sort`).all();
  const getTx = (ref) => db.prepare('SELECT * FROM transactions WHERE ref = ?').get(String(ref || ''));
  const hmac = (v) => crypto.createHmac('sha256', auth.SECRET).update(v).digest('base64url');
  const mask = (p) => { p = p.replace(/^\+242/, ''); return `+242 ${p.slice(0, 2)} *** ** ${p.slice(7)}`; };
  const devBanner = () => (pay.isDev ? '<div class="notice test">🧪 <strong>Mode test</strong> — paiements simulés : aucun argent n\'est débité. Vous choisirez le résultat (réussite ou échec) à l\'étape suivante.</div>' : '');
  const boostable = (ad) => ad && ad.status === 'active' && ad.expires_at > Date.now();

  // --- cœur : finalisation idempotente + activation du boost ---
  function applyBoost(tx) {
    const ad = tx.ad_id && db.prepare('SELECT * FROM ads WHERE id = ?').get(tx.ad_id);
    if (!ad) return false;
    const now = Date.now(); const add = tx.duration_days * DAY;
    if (tx.product_code === 'une') db.prepare('UPDATE ads SET featured_until = ? WHERE id = ?').run(Math.max(now, ad.featured_until || 0) + add, ad.id);
    else if (tx.product_code === 'urgent') db.prepare('UPDATE ads SET urgent_until = ? WHERE id = ?').run(Math.max(now, ad.urgent_until || 0) + add, ad.id);
    else if (tx.product_code === 'remonter') db.prepare('UPDATE ads SET created_at = ?, bumped_at = ? WHERE id = ?').run(now, now, ad.id);
    return true;
  }
  // Ne change l'état que depuis « pending » (ou « expired » pour un succès confirmé tardivement par l'opérateur) : rejouer un callback est sans effet.
  function finalize(ref, status, { providerRef = null, reason = null, source = '' } = {}) {
    if (!['success', 'failed', 'expired'].includes(status)) return false;
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const from = status === 'success' ? "('pending','expired')" : "('pending')";
      const ch = db.prepare(`UPDATE transactions SET status = ?, provider_ref = COALESCE(?, provider_ref), failure_reason = ?, completed_at = ?, updated_at = ? WHERE ref = ? AND status IN ${from}`)
        .run(status, providerRef, status === 'success' ? null : reason, now, now, ref).changes;
      let applied = false;
      if (ch && status === 'success') {
        const tx = getTx(ref);
        if (!tx.boost_applied && db.prepare('UPDATE transactions SET boost_applied = 1 WHERE ref = ? AND boost_applied = 0').run(ref).changes) applied = applyBoost(tx);
        audit(null, 'paiement_confirme', 'paiement', tx.id, `${tx.product_name} — ${tx.amount} FCFA — ${pay.OPERATORS[tx.operator].name} ${tx.payer_phone}${source ? ' (' + source + ')' : ''}${applied ? '' : ' — annonce introuvable, boost non appliqué'}`);
      }
      db.exec('COMMIT');
      return !!ch;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  // Interroge l'opérateur (jamais le client) ; expire les demandes trop anciennes
  async function refresh(tx, { force = false } = {}) {
    if (tx.status !== 'pending') return tx;
    const now = Date.now();
    if (tx.provider !== 'dev' && (force || !tx.last_checked_at || now - tx.last_checked_at > 5000)) {
      db.prepare('UPDATE transactions SET last_checked_at = ? WHERE id = ?').run(now, tx.id);
      try { const r = await pay.providerFor(tx.operator).getStatus(tx); if (r.status !== 'pending') finalize(tx.ref, r.status, { providerRef: r.providerRef, reason: r.reason, source: 'vérification du statut' }); }
      catch (e) { console.error('Statut paiement', tx.ref, e.message); }
      tx = getTx(tx.ref);
    }
    if (tx.status === 'pending' && tx.expires_at <= now) { finalize(tx.ref, 'expired', { reason: 'Délai de confirmation dépassé (10 min)' }); tx = getTx(tx.ref); }
    return tx;
  }
  const sweep = async () => { for (const tx of db.prepare("SELECT * FROM transactions WHERE status = 'pending' AND expires_at <= ?").all(Date.now())) await refresh(tx, { force: true }); };
  setInterval(() => sweep().catch((e) => console.error('sweep', e.message)), 30000).unref();

  // --- page « Booster » ---
  function ownBoostAd(req, res) {
    const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(Number(req.params.id) || 0);
    if (!ad) { page(req, res, 404, 'Annonce introuvable', '<a class="btn" href="/mes-annonces">Mes annonces</a>'); return null; }
    if (ad.user_id !== req.user.id) { page(req, res, 403, 'Action non autorisée', '<p>Vous ne pouvez booster que vos propres annonces.</p><a class="btn" href="/mes-annonces">Mes annonces</a>'); return null; }
    if (!boostable(ad)) { page(req, res, 400, 'Annonce non disponible', '<p>Seules les annonces en ligne peuvent être boostées (renouvelez-la si elle a expiré).</p><a class="btn" href="/mes-annonces">Mes annonces</a>'); return null; }
    return ad;
  }
  function boostPage(req, ad, { v = {}, error = '' } = {}) {
    const img = photoUrl(firstPhotoStmt.get(ad.id)?.filename); const now = Date.now();
    const ops = pay.enabledOperators();
    const local = req.user.phone.replace(/^\+242/, '');
    const defOp = v.operator || (local.startsWith('06') ? 'mtn' : 'airtel');
    const active = { une: ad.featured_until > now ? ad.featured_until : 0, urgent: ad.urgent_until > now ? ad.urgent_until : 0 };
    const prods = products();
    const icon = { remonter: '⬆️', une: '⭐', urgent: '🔥' };
    return layout(req, { title: 'Booster mon annonce', body: `<div class="auth boost">
      <h1 class="h1">Booster mon annonce</h1>
      <a class="admini" href="/annonce/${ad.id}"><span class="admini-img">${img ? `<img src="${img}" alt="">` : ''}</span><span class="admini-b"><strong>${esc(ad.title)}</strong><span class="card-price">${fmtPrice(ad.price)}</span><span class="muted small">${esc(ad.city)}</span></span></a>
      ${devBanner()}${error ? `<div class="notice bad">${esc(error)}</div>` : ''}
      ${!ops.length ? '<div class="notice bad">Le paiement Mobile Money n\'est pas encore disponible.</div>' : `
      <form class="pform" method="post" action="/annonce/${ad.id}/booster" id="boostf">${csrfField(req)}
        <fieldset><legend>1. Choisissez une option</legend><div class="opts">
        ${prods.map((p, i) => `<label class="opt"><input type="radio" name="product" value="${p.code}" data-price="${p.price}" ${(v.product ? v.product === p.code : i === 1) ? 'checked' : ''} required>
          <span class="opt-b"><span class="opt-t">${icon[p.code] || '🚀'} ${esc(p.name)} <strong class="opt-p">${fmtPrice(p.price)}</strong></span>
          <span class="small muted">${esc(p.description)}${p.duration_days ? '' : ''}</span>
          ${active[p.code] ? `<span class="small st st-ok">Actif jusqu'au ${fmtDay(active[p.code])} — sera prolongé de ${p.duration_days} jours</span>` : ''}</span></label>`).join('')}
        </div></fieldset>
        <fieldset><legend>2. Payez avec</legend><div class="ops">
        ${ops.map((o) => `<label class="op op-${o.code}"><input type="radio" name="operator" value="${o.code}" ${defOp === o.code ? 'checked' : ''} required><span>${o.code === 'mtn' ? '🟡' : '🔴'} ${o.name}</span></label>`).join('')}
        </div></fieldset>
        <label>3. Numéro Mobile Money qui paie<div class="phone"><span>+242</span><input name="phone" type="tel" inputmode="tel" required value="${esc(v.phone ?? local)}" placeholder="06 123 45 67"></div>
        <span class="muted small" id="ophint">MTN : 06 · Airtel : 05 ou 04</span></label>
        <button class="btn btn-post big" type="submit" id="paybtn">Payer avec Mobile Money</button>
        <p class="muted small">Vous recevrez une demande de confirmation sur votre téléphone. Le boost est activé dès que le paiement est confirmé par l'opérateur. Paiement unique, sans abonnement.</p>
      </form>`}</div>`, scripts: '<script src="/static/pay.js?v=1" defer></script>' });
  }
  app.get('/annonce/:id/booster', requireUser, (req, res) => { const ad = ownBoostAd(req, res); if (ad) res.send(boostPage(req, ad)); });
  app.post('/annonce/:id/booster', requireUser, auth.csrfGuard, async (req, res) => {
    const ad = ownBoostAd(req, res); if (!ad) return;
    const v = { product: String(req.body.product || ''), operator: String(req.body.operator || ''), phone: String(req.body.phone || '') };
    const prod = db.prepare('SELECT * FROM boost_products WHERE code = ? AND active = 1').get(v.product);
    const op = pay.enabledOperators().find((o) => o.code === v.operator);
    const local = normPhone(v.phone);
    let err = !prod ? 'Choisissez une option de boost.' : !op ? 'Choisissez MTN MoMo ou Airtel Money.' : !local ? 'Numéro invalide (9 chiffres, ex. 06 123 45 67).'
      : !op.prefixes.some((p) => local.startsWith(p)) ? `Ce numéro ne correspond pas à ${op.name} : ${op.hint.toLowerCase()}.` : '';
    const now = Date.now();
    if (!err && db.prepare("SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND status = 'pending' AND expires_at > ?").get(req.user.id, now).n >= 2) err = 'Vous avez déjà des paiements en attente. Validez-les ou attendez leur expiration (10 min).';
    if (!err && db.prepare('SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND created_at > ?').get(req.user.id, now - 3600000).n >= 10) err = 'Trop de demandes de paiement. Réessayez dans une heure.';
    if (err) return res.status(400).send(boostPage(req, ad, { v, error: err }));
    const ref = pay.newRef();
    db.prepare(`INSERT INTO transactions (ref, user_id, ad_id, ad_title, product_code, product_name, duration_days, amount, currency, provider, operator, payer_phone, created_at, updated_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ref, req.user.id, ad.id, ad.title, prod.code, prod.name, prod.duration_days, prod.price, 'XAF', pay.isDev ? 'dev' : op.code, op.code, '+242' + local, now, now, now + TTL);
    const tx = getTx(ref);
    try {
      const cb = process.env.PUBLIC_BASE_URL ? `${process.env.PUBLIC_BASE_URL}/webhooks/${op.code}/${ref}?t=${hmac(op.code + ':' + ref)}` : null;
      const r = await pay.providerFor(op.code).requestToPay(tx, cb);
      if (r.providerRef) db.prepare('UPDATE transactions SET provider_ref = ? WHERE id = ?').run(r.providerRef, tx.id);
    } catch (e) {
      console.error('requestToPay', ref, e.message);
      finalize(ref, 'failed', { reason: "La demande de paiement n'a pas pu être envoyée à l'opérateur." });
    }
    res.redirect(303, `/paiements/${ref}`);
  });

  // --- suivi du paiement / reçu ---
  function ownTx(req, res) {
    const tx = getTx(req.params.ref);
    if (!tx || (tx.user_id !== req.user.id && req.user.role !== 'admin')) { page(req, res, 404, 'Paiement introuvable', '<a class="btn" href="/mes-paiements">Mes paiements</a>'); return null; }
    return tx;
  }
  app.get('/paiements/:ref', requireUser, async (req, res) => {
    let tx = ownTx(req, res); if (!tx) return;
    tx = await refresh(tx);
    const op = pay.OPERATORS[tx.operator];
    const ad = tx.ad_id && db.prepare('SELECT * FROM ads WHERE id = ?').get(tx.ad_id);
    const until = ad && (tx.product_code === 'une' ? ad.featured_until : tx.product_code === 'urgent' ? ad.urgent_until : null);
    const head = `<div class="paycard"><div class="pay-amt">${fmtPrice(tx.amount)}</div><div>${esc(tx.product_name)} — <a href="/annonce/${tx.ad_id}">${esc(tx.ad_title || '')}</a></div>
      <div class="muted small">${op.name} · ${esc(mask(tx.payer_phone))}</div></div>`;
    let body;
    if (tx.status === 'pending') {
      const left = Math.max(0, tx.expires_at - Date.now());
      body = `${head}<div class="pay-wait" id="paywait" data-ref="${tx.ref}" data-left="${left}">
        <div class="spinner" aria-hidden="true"></div>
        <h2 class="h2">Confirmez le paiement sur votre téléphone</h2>
        <ol class="steps"><li>Une demande de paiement de <strong>${fmtPrice(tx.amount)}</strong> a été envoyée au <strong>${esc(mask(tx.payer_phone))}</strong>.</li>
        <li>${esc(op.ussd)}</li><li>Cette page se met à jour automatiquement dès que l'opérateur confirme.</li></ol>
        <p class="muted small">La demande expire dans <strong id="countdown">${Math.ceil(left / 60000)} min</strong>. <noscript><a href="/paiements/${tx.ref}">Actualiser</a></noscript></p></div>
        ${pay.isDev ? `<div class="notice test">🧪 <strong>Mode test</strong> — aucun SMS ni USSD n'est envoyé. Simulez la réponse de l'opérateur :
          <div class="two sim"><form method="post" action="/paiements/${tx.ref}/simuler">${csrfField(req)}<input type="hidden" name="result" value="success"><button class="btn" type="submit">✅ Paiement validé</button></form>
          <form method="post" action="/paiements/${tx.ref}/simuler">${csrfField(req)}<input type="hidden" name="result" value="failed"><button class="btn btn-danger" type="submit">❌ Refusé / solde insuffisant</button></form></div></div>` : ''}`;
    } else if (tx.status === 'success' || tx.status === 'refunded') {
      body = `${tx.status === 'success' ? `<div class="notice ok pay-ok">✅ <strong>Paiement confirmé — boost activé !</strong>${until && until > Date.now() ? ` Votre annonce est ${tx.product_code === 'une' ? '« À la une »' : 'marquée « Urgent »'} jusqu'au ${fmtDay(until)}.` : tx.product_code === 'remonter' ? ' Votre annonce est remontée en tête des annonces récentes.' : ''}</div>`
        : `<div class="notice info">Ce paiement a été remboursé${tx.refund_note ? ' : ' + esc(tx.refund_note) : ''}.</div>`}
        <div class="receipt"><h2 class="h2">Reçu de paiement</h2><table class="tbl">
        <tr><td>Reçu n°</td><td><code>${esc(tx.ref.slice(0, 8).toUpperCase())}</code></td></tr><tr><td>Date</td><td>${fmtDate(tx.completed_at || tx.created_at)}</td></tr>
        <tr><td>Option</td><td>${esc(tx.product_name)}${tx.duration_days ? ` (${tx.duration_days} jours)` : ''}</td></tr><tr><td>Annonce</td><td>${esc(tx.ad_title || '')}</td></tr>
        <tr><td>Montant</td><td>${fmtPrice(tx.amount)}</td></tr><tr><td>Moyen de paiement</td><td>${op.name} ${esc(mask(tx.payer_phone))}</td></tr>
        <tr><td>Réf. opérateur</td><td>${esc(tx.provider_ref || '—')}</td></tr><tr><td>Référence</td><td class="small">${esc(tx.ref)}</td></tr></table></div>
        <div class="two"><a class="btn btn-ghost" href="/annonce/${tx.ad_id}">Voir l'annonce</a><a class="btn btn-ghost" href="/mes-paiements">Mes paiements</a></div>`;
    } else {
      body = `${head}<div class="notice bad">❌ <strong>${tx.status === 'expired' ? 'Paiement expiré' : 'Paiement échoué'}</strong> — ${esc(tx.failure_reason || 'Le paiement n\'a pas été confirmé.')} Aucun boost n'a été activé et rien n'a été débité.</div>
        <p class="muted small">Vérifiez votre solde et que vous avez bien validé la demande avec votre code secret.</p>
        <div class="two">${tx.ad_id ? `<a class="btn" href="/annonce/${tx.ad_id}/booster">Réessayer</a>` : ''}<a class="btn btn-ghost" href="/mes-paiements">Mes paiements</a></div>`;
    }
    res.send(layout(req, { title: 'Paiement', body: `<div class="auth"><h1 class="h1">Paiement ${tx.status === 'pending' ? 'en cours' : ''}</h1>${body}</div>`, scripts: tx.status === 'pending' ? '<script src="/static/pay.js?v=1" defer></script>' : '' }));
  });
  app.get('/paiements/:ref/statut', requireUser, async (req, res) => {
    const tx0 = getTx(req.params.ref);
    if (!tx0 || tx0.user_id !== req.user.id) return res.status(404).json({ ok: false });
    const tx = await refresh(tx0);
    res.set('Cache-Control', 'no-store').json({ ok: true, status: tx.status, left: Math.max(0, tx.expires_at - Date.now()) });
  });
  app.post('/paiements/:ref/simuler', requireUser, auth.csrfGuard, async (req, res) => {
    if (!pay.isDev) return res.status(404).send('Introuvable');
    const tx = getTx(req.params.ref);
    if (!tx || tx.user_id !== req.user.id) return res.status(403).send('Action non autorisée');
    const t = await refresh(tx);
    if (t.status === 'pending') finalize(t.ref, req.body.result === 'success' ? 'success' : 'failed', { providerRef: tx.provider_ref, reason: 'Paiement refusé par l\'abonné (simulation)', source: 'simulation' });
    res.redirect(303, `/paiements/${tx.ref}`);
  });

  app.get('/mes-paiements', requireUser, (req, res) => {
    const txs = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
    const total = txs.filter((t) => t.status === 'success').reduce((s, t) => s + t.amount, 0);
    res.send(layout(req, { title: 'Mes paiements', body: `<h1 class="h1">Mes paiements</h1>
      ${txs.length ? `<p class="muted small">Total payé : <strong>${fmtPrice(total)}</strong></p><div class="mylist">${txs.map((t) => `<a class="urow" href="/paiements/${t.ref}">
        <span class="urow-b"><strong>${esc(t.product_name)}</strong> — ${fmtPrice(t.amount)} <span class="st ${STC[t.status]}">${ST[t.status]}</span>${t.is_example ? ' <span class="st st-wait">EXEMPLE</span>' : ''}<br>
        <span class="small muted">${esc(t.ad_title || '')} · ${pay.OPERATORS[t.operator].name} · ${fmtDate(t.created_at)}</span></span><span>›</span></a>`).join('')}</div>`
        : '<div class="empty">Aucun paiement pour le moment.<br>Boostez une annonce depuis « Mes annonces » pour la rendre plus visible.<br><br><a class="btn" href="/mes-annonces">Mes annonces</a></div>'}` }));
  });

  // --- callbacks opérateurs (jamais crus sur parole : le statut est revérifié auprès de l'opérateur) ---
  app.use('/webhooks', express.json({ limit: '20kb', verify: (req, res, buf) => { req.rawBody = buf; } }));
  const logEvent = (ref, provider, verified, req) => db.prepare('INSERT INTO payment_events (ref, provider, verified, body, created_at) VALUES (?,?,?,?,?)').run(ref || null, provider, verified ? 1 : 0, (req.rawBody || '').toString().slice(0, 4000), Date.now());
  app.post('/webhooks/mtn/:ref', async (req, res) => {
    const ok = req.query.t && req.query.t === hmac('mtn:' + req.params.ref);
    logEvent(req.params.ref, 'mtn', ok, req);
    if (!ok) return res.status(401).json({ ok: false });
    const tx = getTx(req.params.ref);
    if (tx && tx.provider === 'mtn') await refresh(tx, { force: true }).catch(() => {});
    res.json({ ok: true }); // toujours 200 : l'opérateur ne doit pas réessayer indéfiniment
  });
  app.post('/webhooks/airtel', async (req, res) => {
    const ref = req.body?.transaction?.id;
    const v = pay.airtel.verifyCallback(req.rawBody || Buffer.from(''), req.headers);
    logEvent(ref, 'airtel', v !== false, req);
    if (v === false) return res.status(401).json({ ok: false });
    const tx = getTx(ref);
    if (tx && tx.provider === 'airtel') {
      // re-vérification du statut auprès d'Airtel ; si elle échoue et que la signature est valide, on utilise le callback
      const t = await refresh(tx, { force: true }).catch(() => tx);
      if (t.status === 'pending' && v === true) { const sc = req.body.transaction.status_code; if (sc === 'TS' || sc === 'TF') finalize(ref, sc === 'TS' ? 'success' : 'failed', { providerRef: req.body.transaction.airtel_money_id, reason: req.body.transaction.message, source: 'callback signé' }); }
    }
    res.json({ ok: true });
  });
  // Callback simulé (mode test) : signé HMAC-SHA256 avec le secret du serveur (en-tête x-omoni-signature)
  app.post('/webhooks/dev', (req, res) => {
    if (!pay.isDev) return res.status(404).json({ ok: false });
    const sig = String(req.get('x-omoni-signature') || ''); const exp = crypto.createHmac('sha256', auth.SECRET).update(req.rawBody || '').digest('hex');
    const ok = sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
    logEvent(req.body?.ref, 'dev', ok, req);
    if (!ok) return res.status(401).json({ ok: false });
    const changed = finalize(String(req.body.ref || ''), req.body.status, { reason: 'Échec signalé par le callback (simulation)', source: 'callback' });
    res.json({ ok: true, changed, status: getTx(req.body.ref)?.status || null });
  });

  return { finalize, refresh, ST, STC, products };
};
