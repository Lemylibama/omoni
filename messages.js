// Messagerie acheteur <-> vendeur : une conversation par (annonce, acheteur)
const auth = require('./auth');

module.exports = function mountMessages(app, h) {
  const { db, C, esc, layout, page, csrfField, fmtPrice, fmtDate, photoUrl, firstPhotoStmt, audit, requireUser, bannedWordsIn, catBySlug } = h;
  const MAX = C.MSG_MAX_LENGTH || 1000;
  const SAFETY = '<div class="notice test small">🔒 <strong>Prudence :</strong> ne payez jamais d\'avance par Mobile Money (MTN MoMo, Airtel Money) ni par transfert avant d\'avoir vu l\'article. Méfiez-vous des « frais de livraison » ou « frais de dédouanement » demandés à l\'avance. Rencontrez-vous dans un lieu public.</div>';
  const REASONS = ['Arnaque / demande de paiement d\'avance', 'Harcèlement ou insultes', 'Spam / publicité', 'Contenu choquant', 'Autre'];

  const userName = (u, fallback) => (u?.display_name || fallback || 'Utilisateur ' + C.BRAND);
  const isBlocked = (a, b) => !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(a, b);
  const isBanned = (uid) => !!db.prepare('SELECT banned_at FROM users WHERE id = ?').get(uid)?.banned_at;
  const adOpenForContact = (ad) => ad && ad.user_id && ad.status === 'active' && ad.expires_at > Date.now() && !isBanned(ad.user_id);
  const role = (c, uid) => (c.buyer_id === uid ? 'buyer' : c.seller_id === uid ? 'seller' : null);
  const otherId = (c, uid) => (c.buyer_id === uid ? c.seller_id : c.buyer_id);
  const markRead = (c, uid) => {
    const last = db.prepare('SELECT MAX(id) m FROM messages WHERE conversation_id = ?').get(c.id).m || 0;
    db.prepare(`UPDATE conversations SET ${role(c, uid) === 'buyer' ? 'buyer_last_read' : 'seller_last_read'} = ? WHERE id = ?`).run(last, c.id);
  };
  function getConv(req, res) {
    const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(req.params.id) || 0);
    if (!c) { page(req, res, 404, 'Conversation introuvable', '<a class="btn" href="/messages">Mes messages</a>'); return null; }
    if (!role(c, req.user.id)) { page(req, res, 403, 'Accès refusé', '<p>Vous ne participez pas à cette conversation.</p><a class="btn" href="/messages">Mes messages</a>'); return null; }
    return c;
  }
  // Contrôles communs à l'envoi d'un message ; renvoie un message d'erreur ou null
  function sendCheck(req, c, body) {
    if (isBanned(req.user.id)) return 'Votre compte est suspendu : vous ne pouvez pas envoyer de message.';
    if (!body) return 'Le message est vide.';
    if (body.length > MAX) return `Message trop long (${MAX} caractères maximum).`;
    if (c) {
      const other = otherId(c, req.user.id);
      if (isBlocked(other, req.user.id)) return 'Cet utilisateur ne souhaite plus recevoir vos messages.';
      if (isBlocked(req.user.id, other)) return 'Vous avez bloqué cet utilisateur. Débloquez-le pour lui écrire.';
      if (isBanned(other)) return 'Ce compte est suspendu : il ne peut plus recevoir de messages.';
    }
    const n = db.prepare('SELECT COUNT(*) n FROM messages WHERE sender_id = ? AND created_at > ?').get(req.user.id, Date.now() - 10 * 60000).n;
    if (n >= C.MSG_RATE_10MIN) return 'Vous envoyez trop de messages. Patientez quelques minutes.';
    return null;
  }
  // Insère un message (avec filtre de mots interdits) ; renvoie { msg } ou { error }
  function insertMessage(req, c, body) {
    const flagged = bannedWordsIn(body);
    if (flagged.length && db.getSetting('banned_words_action') === 'reject') return { error: 'Votre message contient des mots interdits et n\'a pas été envoyé.' };
    const now = Date.now();
    const id = db.prepare('INSERT INTO messages (conversation_id, sender_id, body, flagged_words, created_at) VALUES (?,?,?,?,?)').run(c.id, req.user.id, body, flagged.join(', ') || null, now).lastInsertRowid;
    db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(now, c.id);
    markRead(c, req.user.id);
    if (flagged.length) {
      db.prepare('INSERT INTO conversation_reports (conversation_id, reporter_id, reason, details, created_at) VALUES (?, NULL, ?, ?, ?)').run(c.id, 'Mots interdits détectés', `Message n° ${id} : ${flagged.join(', ')}`, now);
      audit(null, 'message_mots_interdits', 'conversation', c.id, `${flagged.join(', ')} (message n° ${id})`);
    }
    return { msg: { id, body, mine: true, time: fmtDate(now) } };
  }
  const bubble = (m, me) => `<div class="bubble ${m.sender_id === me ? 'me' : 'them'}" data-id="${m.id}"><div class="btext">${esc(m.body)}</div><div class="btime">${fmtDate(m.created_at)}</div></div>`;
  const adMini = (c) => {
    const ad = c.ad_id ? db.prepare('SELECT * FROM ads WHERE id = ?').get(c.ad_id) : null;
    const img = ad && photoUrl(firstPhotoStmt.get(ad.id)?.filename);
    const state = !ad ? 'Annonce supprimée' : ad.status === 'sold' ? 'Vendu' : ad.status !== 'active' || ad.expires_at <= Date.now() ? 'Plus en ligne' : '';
    return { ad, html: `<${ad ? `a href="/annonce/${ad.id}"` : 'div'} class="admini"><span class="admini-img">${img ? `<img src="${img}" alt="" loading="lazy">` : `<span class="noimg">${ad ? catBySlug[ad.category]?.icon || '📦' : '🗑'}</span>`}</span>
      <span class="admini-b"><strong>${esc(ad ? ad.title : c.ad_title)}</strong>${ad ? `<span class="card-price">${fmtPrice(ad.price)}</span>` : ''}${state ? `<span class="st st-sold">${state}</span>` : ''}</span></${ad ? 'a' : 'div'}>` };
  };

  // --- démarrer une conversation depuis une annonce ---
  function composePage(req, ad, { text = '', error = '' } = {}) {
    const img = photoUrl(firstPhotoStmt.get(ad.id)?.filename);
    return layout(req, { title: 'Envoyer un message', body: `<div class="auth chat-new">
      <h1 class="h1">Envoyer un message</h1>
      <a class="admini" href="/annonce/${ad.id}"><span class="admini-img">${img ? `<img src="${img}" alt="">` : ''}</span><span class="admini-b"><strong>${esc(ad.title)}</strong><span class="card-price">${fmtPrice(ad.price)}</span><span class="muted small">${esc(ad.seller_name)} · ${esc(ad.city)}</span></span></a>
      ${SAFETY}${error ? `<div class="notice bad">${esc(error)}</div>` : ''}
      <form class="pform" method="post" action="/annonce/${ad.id}/contacter">${csrfField(req)}
        <label>Votre message<textarea name="body" rows="5" maxlength="${MAX}" required>${esc(text || `Bonjour, votre annonce « ${ad.title} » est-elle toujours disponible ?`)}</textarea></label>
        <p class="muted small">Le vendeur verra votre nom affiché, pas votre numéro (sauf si vous le lui donnez).</p>
        <button class="btn big" type="submit">✉️ Envoyer</button></form></div>` });
  }
  function contactGuard(req, res) {
    const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(Number(req.params.id) || 0);
    const existing = ad && db.prepare('SELECT id FROM conversations WHERE ad_id = ? AND buyer_id = ?').get(ad.id, req.user.id);
    if (existing) { res.redirect(303, `/messages/${existing.id}`); return null; }
    if (!ad) { page(req, res, 404, 'Annonce introuvable', '<a class="btn" href="/annonces">Voir les annonces</a>'); return null; }
    if (ad.user_id === req.user.id) { page(req, res, 400, 'C\'est votre annonce', '<p>Vous ne pouvez pas vous envoyer de message.</p><a class="btn" href="/messages">Mes messages</a>'); return null; }
    if (!adOpenForContact(ad)) { page(req, res, 410, 'Annonce indisponible', '<p>Cette annonce n\'est plus en ligne (vendue, expirée ou retirée).</p><a class="btn" href="/annonces">Voir les annonces</a>'); return null; }
    if (isBlocked(ad.user_id, req.user.id)) { page(req, res, 403, 'Contact impossible', '<p>Ce vendeur ne souhaite pas recevoir vos messages.</p>'); return null; }
    return ad;
  }
  app.get('/annonce/:id/contacter', requireUser, (req, res) => { const ad = contactGuard(req, res); if (ad) res.send(composePage(req, ad)); });
  app.post('/annonce/:id/contacter', requireUser, auth.csrfGuard, (req, res) => {
    const ad = contactGuard(req, res); if (!ad) return;
    const body = String(req.body.body || '').trim();
    let err = sendCheck(req, null, body);
    if (!err && isBlocked(req.user.id, ad.user_id)) err = 'Vous avez bloqué ce vendeur. Débloquez-le depuis vos messages pour lui écrire.';
    if (!err && db.prepare('SELECT COUNT(*) n FROM conversations WHERE buyer_id = ? AND created_at > ?').get(req.user.id, Date.now() - 86400000).n >= C.CONV_RATE_DAY) err = 'Vous avez contacté trop de vendeurs aujourd\'hui. Réessayez demain.';
    if (err) return res.status(err.includes('trop') ? 429 : 400).send(composePage(req, ad, { text: body, error: err }));
    const now = Date.now();
    const cid = db.prepare('INSERT INTO conversations (ad_id, ad_title, buyer_id, seller_id, created_at, last_message_at) VALUES (?,?,?,?,?,?)').run(ad.id, ad.title, req.user.id, ad.user_id, now, now).lastInsertRowid;
    const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(cid);
    const r = insertMessage(req, c, body);
    if (r.error) { db.prepare('DELETE FROM conversations WHERE id = ?').run(cid); return res.status(400).send(composePage(req, ad, { text: body, error: r.error })); }
    res.redirect(303, `/messages/${cid}`);
  });

  // --- boîte de réception ---
  app.get('/messages', requireUser, (req, res) => {
    const me = req.user.id;
    const convs = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != ? AND m.id > CASE WHEN c.buyer_id = ? THEN c.buyer_last_read ELSE c.seller_last_read END) unread,
      (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) last_body,
      (SELECT sender_id FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) last_sender
      FROM conversations c WHERE c.buyer_id = ? OR c.seller_id = ? ORDER BY c.last_message_at DESC LIMIT 200`).all(me, me, me, me);
    const rows = convs.map((c) => {
      const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId(c, me));
      const ad = c.ad_id ? db.prepare('SELECT * FROM ads WHERE id = ?').get(c.ad_id) : null;
      const img = ad && photoUrl(firstPhotoStmt.get(ad.id)?.filename);
      const name = userName(other, c.seller_id === other?.id ? ad?.seller_name : null);
      return `<a class="conv ${c.unread ? 'unread' : ''}" href="/messages/${c.id}"><span class="conv-img">${img ? `<img src="${img}" alt="" loading="lazy">` : `<span class="noimg">${ad ? catBySlug[ad.category]?.icon : '🗑'}</span>`}</span>
        <span class="conv-b"><span class="conv-top"><strong>${esc(name)}</strong><span class="muted small">${fmtDate(c.last_message_at)}</span></span>
        <span class="conv-ad">${c.is_example ? '<span class="st st-wait">EXEMPLE</span> ' : ''}${c.seller_id === me ? '<span class="st st-ok">Vente</span>' : '<span class="st st-sold">Achat</span>'} ${esc(ad ? ad.title : c.ad_title)}${ad ? ' · ' + fmtPrice(ad.price) : ' (supprimée)'}</span>
        <span class="conv-last">${c.last_sender === me ? 'Vous : ' : ''}${esc((c.last_body || '').slice(0, 90))}</span></span>
        ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</a>`;
    });
    res.send(layout(req, { title: 'Messages', body: `<h1 class="h1">Messages</h1>
      ${rows.length ? `<div class="convs">${rows.join('')}</div>` : '<div class="empty">Aucune conversation pour le moment.<br>Touchez « Envoyer un message » sur une annonce pour contacter un vendeur.<br><br><a class="btn" href="/annonces">Parcourir les annonces</a></div>'}` }));
  });

  // --- conversation ---
  app.get('/messages/:id', requireUser, (req, res) => {
    const c = getConv(req, res); if (!c) return;
    const me = req.user.id; const oid = otherId(c, me);
    const other = db.prepare('SELECT * FROM users WHERE id = ?').get(oid);
    const { ad, html } = adMini(c);
    const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(c.id);
    markRead(c, me);
    const iBlocked = isBlocked(me, oid), theyBlocked = isBlocked(oid, me), otherBanned = !!other?.banned_at;
    const canSend = !iBlocked && !theyBlocked && !otherBanned;
    const name = userName(other, c.seller_id === oid ? ad?.seller_name : null);
    const err = req.query.err ? `<div class="notice bad">${esc(req.query.err)}</div>` : '';
    const ok = req.query.signale ? '<div class="notice ok">Merci, la conversation a été signalée à notre équipe de modération.</div>' : req.query.bloque ? `<div class="notice ok">${req.query.bloque === '1' ? 'Utilisateur bloqué : il ne peut plus vous écrire.' : 'Utilisateur débloqué.'}</div>` : '';
    const body = `<div class="chat" id="chat" data-conv="${c.id}" data-last="${msgs.length ? msgs[msgs.length - 1].id : 0}">
      <div class="chat-head"><a href="/messages" class="back" aria-label="Retour aux messages">←</a><div><strong>${esc(name)}</strong><div class="muted small">${c.seller_id === me ? 'Acheteur intéressé par votre annonce' : 'Vendeur'}${otherBanned ? ' · compte suspendu' : ''}</div></div></div>
      ${html}${c.is_example ? '<div class="notice info small"><strong>EXEMPLE</strong> — conversation fictive entre comptes de démonstration.</div>' : ''}
      ${SAFETY}${ok}${err}
      <div class="bubbles" id="bubbles">${msgs.map((m) => bubble(m, me)).join('') || '<p class="muted small">Aucun message.</p>'}</div>
      ${canSend ? `<form class="sendf" id="sendf" method="post" action="/messages/${c.id}">${csrfField(req)}
        <textarea name="body" rows="2" maxlength="${MAX}" required placeholder="Écrire un message…" aria-label="Message"></textarea>
        <button class="btn" type="submit" aria-label="Envoyer">Envoyer</button></form><p class="muted small" id="chatmsg">Actualisation automatique toutes les 10 secondes.</p>`
        : `<div class="notice info">${iBlocked ? 'Vous avez bloqué cet utilisateur : il ne peut plus vous écrire.' : theyBlocked ? 'Cet utilisateur ne souhaite plus recevoir vos messages.' : 'Ce compte est suspendu.'}</div>`}
      <details class="report chat-opts"><summary>⋯ Options : bloquer, signaler</summary>
        <form method="post" action="/messages/${c.id}/bloquer">${csrfField(req)}<button class="btn btn-ghost sm" type="submit">${iBlocked ? '✅ Débloquer' : '🚫 Bloquer'} ${esc(name)}</button></form>
        <form method="post" action="/messages/${c.id}/signaler">${csrfField(req)}
          <label>Signaler la conversation<select name="reason">${REASONS.map((r) => `<option>${esc(r)}</option>`).join('')}</select></label>
          <label>Précisions (facultatif)<textarea name="details" rows="2" maxlength="500"></textarea></label>
          <button class="btn btn-danger sm" type="submit">🚩 Signaler</button>
          <p class="muted small">L'équipe de modération pourra lire cette conversation pour vérifier le signalement.</p></form></details>
    </div>`;
    res.send(layout(req, { title: 'Conversation · ' + name, body, scripts: '<script src="/static/chat.js?v=1" defer></script>' }));
  });

  app.post('/messages/:id', requireUser, auth.csrfGuard, (req, res) => {
    const c = getConv(req, res); if (!c) return;
    const json = req.get('accept')?.includes('application/json');
    const body = String(req.body.body || '').trim();
    const err = sendCheck(req, c, body);
    const r = err ? { error: err } : insertMessage(req, c, body);
    if (r.error) return json ? res.status(r.error.includes('trop de messages') ? 429 : 400).json({ ok: false, error: r.error }) : res.redirect(303, `/messages/${c.id}?err=${encodeURIComponent(r.error)}`);
    json ? res.json({ ok: true, message: r.msg }) : res.redirect(303, `/messages/${c.id}#bubbles`);
  });

  // nouvelles données pour l'actualisation automatique (JSON léger)
  app.get('/messages/:id/nouveaux', requireUser, (req, res) => {
    const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(req.params.id) || 0);
    if (!c || !role(c, req.user.id)) return res.status(403).json({ ok: false });
    const after = Number(req.query.apres) || 0;
    const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT 100').all(c.id, after);
    if (msgs.length) markRead(c, req.user.id);
    res.set('Cache-Control', 'no-store').json({ ok: true, unread: db.unreadCount(req.user.id), messages: msgs.map((m) => ({ id: m.id, body: m.body, mine: m.sender_id === req.user.id, time: fmtDate(m.created_at) })) });
  });

  app.post('/messages/:id/bloquer', requireUser, auth.csrfGuard, (req, res) => {
    const c = getConv(req, res); if (!c) return;
    const oid = otherId(c, req.user.id);
    const blocked = isBlocked(req.user.id, oid);
    if (blocked) db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, oid);
    else db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)').run(req.user.id, oid, Date.now());
    res.redirect(303, `/messages/${c.id}?bloque=${blocked ? '0' : '1'}`);
  });
  app.post('/messages/:id/signaler', requireUser, auth.csrfGuard, (req, res) => {
    const c = getConv(req, res); if (!c) return;
    const reason = REASONS.includes(req.body.reason) ? req.body.reason : 'Autre';
    db.prepare('INSERT INTO conversation_reports (conversation_id, reporter_id, reason, details, created_at) VALUES (?,?,?,?,?)').run(c.id, req.user.id, reason, String(req.body.details || '').slice(0, 500), Date.now());
    res.redirect(303, `/messages/${c.id}?signale=1`);
  });

  return { adOpenForContact };
};
