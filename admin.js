// Panneau d'administration / modération — toutes les routes /admin exigent un compte administrateur + jeton CSRF
const auth = require('./auth');

module.exports = function mountAdmin(app, h) {
  const { alerts, db, C, esc, layout, csrfField, fmtPrice, fmtDate, fmtPhone, normPhone, catBySlug, photoUrl, firstPhotoStmt, audit, STATUS_FR, deletePhotoFiles, LIVE, safeNext, DAY } = h;
  const now = () => Date.now();
  const STATUSES = ['active', 'expired', 'sold', 'hidden', 'pending', 'rejected'];
  const stBadge = (ad) => {
    const exp = ad.expires_at <= now() && ad.status === 'active';
    const cls = { active: 'st-ok', sold: 'st-sold', hidden: 'st-bad', pending: 'st-wait', rejected: 'st-bad' }[ad.status] || 'st-sold';
    return `<span class="st ${exp ? 'st-bad' : cls}">${exp ? 'Expirée' : esc(STATUS_FR[ad.status] || ad.status)}</span>`;
  };

  // --- accès ---
  app.use('/admin', (req, res, next) => {
    if (!req.user) return res.redirect(303, '/connexion?next=' + encodeURIComponent(req.method === 'GET' ? req.originalUrl : '/admin'));
    if (req.user.role !== 'admin') return res.status(403).send(layout(req, { title: 'Accès refusé', body: '<div class="empty"><h1 class="h1">Accès refusé</h1><p>Cette section est réservée aux administrateurs.</p><a class="btn" href="/">Retour à l\'accueil</a></div>' }));
    res.set('Cache-Control', 'private, no-store');
    if (req.method === 'POST') return auth.csrfGuard(req, res, next);
    next();
  });

  const counts = () => ({
    reports: db.prepare("SELECT COUNT(DISTINCT ad_id) n FROM reports WHERE status = 'open'").get().n + db.prepare("SELECT COUNT(DISTINCT conversation_id) n FROM conversation_reports WHERE status = 'open'").get().n,
    pending: db.prepare("SELECT COUNT(*) n FROM ads WHERE status = 'pending'").get().n,
  });
  function adminPage(req, tab, title, body) {
    const c = counts();
    const tabs = [['', 'Tableau de bord', ''], ['signalements', 'Signalements', c.reports], ['moderation', 'À valider', c.pending], ['annonces', 'Annonces', ''], ['utilisateurs', 'Utilisateurs', ''], ['paiements', 'Paiements', ''], ['boosts', 'Tarifs', ''], ['alertes', 'Alertes', ''], ['journal', 'Journal', '']];
    const msg = req.query.ok ? `<div class="notice ok">${esc(req.query.ok)}</div>` : req.query.err ? `<div class="notice bad">${esc(req.query.err)}</div>` : '';
    return layout(req, { title: 'Admin · ' + title, body: `<div class="admin">
      <nav class="atabs">${tabs.map(([k, l, n]) => `<a class="${tab === k ? 'on' : ''}" href="/admin${k ? '/' + k : ''}">${l}${n ? ` <span class="badge">${n}</span>` : ''}</a>`).join('')}</nav>
      ${msg}<h1 class="h1">${esc(title)}</h1>${body}</div>` });
  }
  const back = (req, fallback) => safeNext(req.body.back || fallback);
  const go = (res, url, ok) => res.redirect(303, url + (url.includes('?') ? '&' : '?') + 'ok=' + encodeURIComponent(ok));
  const backField = (req) => `<input type="hidden" name="back" value="${esc(req.originalUrl.replace(/([?&])(ok|err)=[^&]*/g, '$1'))}">`;
  const form = (req, action, label, cls = 'btn-ghost', extra = '') => `<form method="post" action="${action}" class="af">${csrfField(req)}${backField(req)}${extra}<button class="btn sm ${cls}" type="submit">${label}</button></form>`;
  const reasonForm = (req, action, label, ph, cls = 'btn-danger', required = true) => `<details class="af-r"><summary class="btn sm ${cls}">${label}</summary>
    <form method="post" action="${action}">${csrfField(req)}${backField(req)}<input name="reason" maxlength="200" ${required ? 'required' : ''} placeholder="${esc(ph)}"><button class="btn sm ${cls}" type="submit">Confirmer</button></form></details>`;
  const adLine = (req, ad, { actions = true } = {}) => {
    const img = photoUrl(firstPhotoStmt.get(ad.id)?.filename);
    const seller = ad.user_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(ad.user_id) : null;
    return `<div class="myad" id="ad-${ad.id}"><a class="myad-img" href="/annonce/${ad.id}">${img ? `<img src="${img}" alt="" loading="lazy">` : `<span class="noimg">${catBySlug[ad.category]?.icon}</span>`}</a>
    <div class="myad-b"><a class="myad-t" href="/annonce/${ad.id}">${esc(ad.title)}</a> <span class="muted small">n° ${ad.id}</span><div class="card-price">${fmtPrice(ad.price)}</div>
    <div class="small">${stBadge(ad)} ${ad.is_example ? '<span class="st st-sold">Exemple</span>' : ''} <span class="muted">${esc(catBySlug[ad.category]?.name)} · ${esc(ad.city)} · ${fmtDate(ad.created_at)}</span></div>
    <div class="small muted">Vendeur : ${seller ? `<a href="/admin/utilisateurs/${seller.id}">${esc(seller.display_name || fmtPhone(seller.phone))}</a> (${esc(fmtPhone(seller.phone))})${seller.banned_at ? ' <span class="st st-bad">Banni</span>' : ''}` : '—'} · contact ${esc(fmtPhone(ad.phone))}</div>
    ${ad.flagged_words ? `<div class="small"><span class="st st-bad">Mots interdits</span> ${esc(ad.flagged_words)}</div>` : ''}
    ${ad.moderation_note ? `<div class="small muted">Note : ${esc(ad.moderation_note)}</div>` : ''}</div>
    ${actions ? `<div class="myad-a"><a class="btn sm btn-ghost" href="/annonce/${ad.id}">👁 Voir</a>
      ${['active', 'sold', 'pending'].includes(ad.status) ? reasonForm(req, `/admin/annonces/${ad.id}/masquer`, '🙈 Masquer', 'Motif (visible par le vendeur)', 'btn-ghost') : ''}
      ${['hidden', 'rejected'].includes(ad.status) ? form(req, `/admin/annonces/${ad.id}/retablir`, '↩ Rétablir') : ''}
      ${ad.status === 'pending' ? form(req, `/admin/annonces/${ad.id}/approuver`, '✅ Approuver', '') + reasonForm(req, `/admin/annonces/${ad.id}/refuser`, '✖ Refuser', 'Motif du refus (visible par le vendeur)') : ''}
      ${form(req, `/admin/annonces/${ad.id}/supprimer`, '🗑 Supprimer', 'btn-ghost danger', '')}</div>` : ''}</div>`;
  };

  // --- tableau de bord ---
  app.get('/admin', (req, res) => {
    const t = now(); const todayStart = Math.floor((t + 3600000) / DAY) * DAY - 3600000; // minuit à Brazzaville (UTC+1)
    const one = (sql, ...p) => db.prepare(sql).get(...p).n;
    const stats = [
      ['Annonces en ligne', one(`SELECT COUNT(*) n FROM ads WHERE ${LIVE()}`), '/admin/annonces?statut=active'],
      ["Nouvelles aujourd'hui", one('SELECT COUNT(*) n FROM ads WHERE created_at >= ? AND renewed_at IS NULL', todayStart), '/admin/annonces'],
      ['Nouvelles (7 jours)', one('SELECT COUNT(*) n FROM ads WHERE created_at >= ? AND renewed_at IS NULL', t - 7 * DAY), '/admin/annonces'],
      ['Utilisateurs', one('SELECT COUNT(*) n FROM users'), '/admin/utilisateurs'],
      ['Signalements ouverts', one("SELECT COUNT(*) n FROM reports WHERE status = 'open'"), '/admin/signalements'],
      ['À valider', one("SELECT COUNT(*) n FROM ads WHERE status = 'pending'"), '/admin/moderation'],
      ['Annonces masquées', one("SELECT COUNT(*) n FROM ads WHERE status = 'hidden'"), '/admin/annonces?statut=hidden'],
      ['Conversations signalées', one("SELECT COUNT(DISTINCT conversation_id) n FROM conversation_reports WHERE status = 'open'"), '/admin/signalements#conversations'],
      ['Messages (7 jours)', one('SELECT COUNT(*) n FROM messages WHERE created_at >= ?', t - 7 * DAY), '/admin'],
      ['Utilisateurs bannis', one('SELECT COUNT(*) n FROM users WHERE banned_at IS NOT NULL'), '/admin/utilisateurs?filtre=bannis'],
    ];
    const rev = (from) => db.prepare("SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE status = 'success' AND is_example = 0 AND completed_at >= ?").get(from).n;
    const fp = (n) => fmtPrice(n).replace('Prix à discuter', '0 FCFA');
    const money = [
      ["Recettes aujourd'hui", fp(rev(todayStart)), '/admin/paiements?statut=success'],
      ['Recettes (30 jours)', fp(rev(t - 30 * DAY)), '/admin/paiements?statut=success'],
      ['Recettes (total)', fp(rev(0)), '/admin/paiements?statut=success'],
      ['Annonces boostées actives', one(`SELECT COUNT(*) n FROM ads WHERE ${LIVE()} AND (featured_until > ? OR urgent_until > ?)`, t, t), '/admin/paiements'],
    ];
    const al = alerts.stats24();
    const alertTiles = [['Alertes envoyées (24 h)', al.sent || 0, '/admin/alertes?statut=sent'], ['Alertes en attente', al.queued || 0, '/admin/alertes?statut=queued'],
      ['Non envoyées (24 h)', al.skipped || 0, '/admin/alertes?statut=skipped'], ['Échecs d\'envoi (24 h)', al.failed || 0, '/admin/alertes?statut=failed']];
    const byCat = Object.fromEntries(db.prepare(`SELECT category k, COUNT(*) n FROM ads WHERE ${LIVE()} GROUP BY category`).all().map((r) => [r.k, r.n]));
    const byCity = db.prepare(`SELECT city k, COUNT(*) n FROM ads WHERE ${LIVE()} GROUP BY city ORDER BY n DESC`).all();
    const premod = db.getSetting('premoderation') === '1';
    const body = `<h2 class="h2">Paiements (hors exemples, remboursements déduits)</h2><div class="stats">${money.map(([l, n, href]) => `<a class="stat" href="${href}"><strong class="money">${n}</strong><span>${l}</span></a>`).join('')}</div>
    <h2 class="h2">Activité</h2><div class="stats">${stats.map(([l, n, href]) => `<a class="stat" href="${href}"><strong>${n}</strong><span>${l}</span></a>`).join('')}</div>
    <h2 class="h2">Alertes nouveaux messages (SMS / WhatsApp)</h2><div class="stats">${alertTiles.map(([l, n, href]) => `<a class="stat" href="${href}"><strong>${n}</strong><span>${l}</span></a>`).join('')}</div>
    <p class="small muted">Pré-modération : <strong>${premod ? 'activée' : 'désactivée'}</strong> · <a href="/admin/moderation#reglages">Réglages</a></p>
    <div class="two-col"><div><h2 class="h2">Par catégorie (en ligne)</h2><table class="tbl">${C.CATEGORIES.map((c) => `<tr><td>${c.icon} ${esc(c.name)}</td><td><a href="/admin/annonces?cat=${c.slug}&statut=active">${byCat[c.slug] || 0}</a></td></tr>`).join('')}</table></div>
    <div><h2 class="h2">Par ville (en ligne)</h2><table class="tbl">${byCity.map((r) => `<tr><td>${esc(r.k)}</td><td><a href="/admin/annonces?ville=${encodeURIComponent(r.k)}&statut=active">${r.n}</a></td></tr>`).join('') || '<tr><td>—</td></tr>'}</table></div></div>`;
    res.send(adminPage(req, '', 'Tableau de bord', body));
  });

  // --- signalements ---
  app.get('/admin/signalements', (req, res) => {
    if (req.query.vue === 'historique') {
      const rows = db.prepare(`SELECT r.*, a.title, u.phone admin_phone FROM reports r LEFT JOIN ads a ON a.id = r.ad_id LEFT JOIN users u ON u.id = r.resolved_by WHERE r.status != 'open' ORDER BY r.resolved_at DESC LIMIT 200`).all();
      const body = `<p><a href="/admin/signalements">← Signalements ouverts</a></p>
      <div class="mylist">${rows.map((r) => `<div class="logrow"><div><strong>${esc(r.reason)}</strong> — <a href="/annonce/${r.ad_id}">${esc(r.title || 'annonce n° ' + r.ad_id)}</a></div>
        <div class="small muted">${r.details ? '« ' + esc(r.details) + ' » · ' : ''}signalé ${fmtDate(r.created_at).toLowerCase()} · ${r.status === 'dismissed' ? 'classé' : 'traité'} ${r.resolved_at ? fmtDate(r.resolved_at).toLowerCase() : ''} par ${esc(r.admin_phone ? fmtPhone(r.admin_phone) : 'système')}${r.resolution ? ' · ' + esc(r.resolution) : ''}</div></div>`).join('') || '<div class="empty">Aucun signalement traité.</div>'}</div>`;
      const crows = db.prepare(`SELECT r.*, c.ad_title, u.phone admin_phone FROM conversation_reports r LEFT JOIN conversations c ON c.id = r.conversation_id LEFT JOIN users u ON u.id = r.resolved_by WHERE r.status != 'open' ORDER BY r.resolved_at DESC LIMIT 100`).all();
      const cbody = `<h2 class="h2">Conversations</h2><div class="mylist">${crows.map((r) => `<div class="logrow"><div><strong>${esc(r.reason)}</strong> — conversation n° ${r.conversation_id} (${esc(r.ad_title || '')})</div>
        <div class="small muted">${r.details ? '« ' + esc(r.details) + ' » · ' : ''}${r.reporter_id ? 'signalé' : 'détection automatique'} ${fmtDate(r.created_at).toLowerCase()} · ${r.status === 'dismissed' ? 'classé' : 'traité'} par ${esc(r.admin_phone ? fmtPhone(r.admin_phone) : 'système')}${r.resolution ? ' · ' + esc(r.resolution) : ''}</div></div>`).join('') || '<div class="empty">Aucune.</div>'}</div>`;
      return res.send(adminPage(req, 'signalements', 'Historique des signalements', '<h2 class="h2">Annonces</h2>' + body + cbody));
    }
    const groups = db.prepare("SELECT ad_id, COUNT(*) n, MAX(created_at) last FROM reports WHERE status = 'open' GROUP BY ad_id ORDER BY n DESC, last DESC").all();
    const body = `<p class="small muted">Signalements en attente, regroupés par annonce. <a href="/admin/signalements?vue=historique">Voir l'historique</a></p>
    <div class="mylist">${groups.map((g) => {
      const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(g.ad_id);
      const reps = db.prepare("SELECT * FROM reports WHERE ad_id = ? AND status = 'open' ORDER BY created_at DESC").all(g.ad_id);
      return `<div class="rgroup"><div class="rhead"><span class="badge big">${g.n} signalement${g.n > 1 ? 's' : ''}</span></div>
        <ul class="rlist">${reps.map((r) => `<li><strong>${esc(r.reason)}</strong>${r.details ? ' — « ' + esc(r.details) + ' »' : ''} <span class="muted small">${fmtDate(r.created_at)}</span></li>`).join('')}</ul>
        ${adLine(req, ad, { actions: false })}
        <div class="myad-a">${form(req, `/admin/signalements/${ad.id}/classer`, '👌 Classer sans suite')}
          ${ad.status !== 'hidden' ? reasonForm(req, `/admin/annonces/${ad.id}/masquer`, '🙈 Masquer l\'annonce', 'Motif (visible par le vendeur)', 'btn-ghost') : form(req, `/admin/annonces/${ad.id}/retablir`, '↩ Rétablir l\'annonce')}
          ${form(req, `/admin/annonces/${ad.id}/supprimer`, '🗑 Supprimer', 'btn-ghost danger')}
          ${ad.user_id && !db.prepare('SELECT banned_at FROM users WHERE id = ?').get(ad.user_id)?.banned_at ? reasonForm(req, `/admin/utilisateurs/${ad.user_id}/bannir`, '⛔ Bannir le vendeur', 'Motif du bannissement') : ''}</div></div>`;
    }).join('') || '<div class="empty">🎉 Aucun signalement en attente.</div>'}</div>`;
    const cgroups = db.prepare("SELECT conversation_id, COUNT(*) n, MAX(created_at) last FROM conversation_reports WHERE status = 'open' GROUP BY conversation_id ORDER BY last DESC").all();
    const cbody = `<h2 class="h2" id="conversations">Conversations signalées</h2>
    <p class="small muted">Par respect de la vie privée, seules les conversations signalées (par un participant ou par le filtre de mots interdits) peuvent être lues. Chaque lecture est inscrite au journal.</p>
    <div class="mylist">${cgroups.map((g) => {
      const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(g.conversation_id);
      const reps = db.prepare("SELECT r.*, u.display_name, u.phone FROM conversation_reports r LEFT JOIN users u ON u.id = r.reporter_id WHERE r.conversation_id = ? AND r.status = 'open' ORDER BY r.created_at DESC").all(c.id);
      return `<div class="rgroup" id="conv-${c.id}"><div class="rhead"><span class="badge big">${g.n} signalement${g.n > 1 ? 's' : ''}</span> <strong>Conversation n° ${c.id}</strong> — ${esc(c.ad_title)}</div>
        <div class="small muted">${participants(c)}</div>
        <ul class="rlist">${reps.map((r) => `<li><strong>${esc(r.reason)}</strong>${r.details ? ' — « ' + esc(r.details) + ' »' : ''} <span class="muted small">${r.reporter_id ? 'par ' + esc(r.display_name || fmtPhone(r.phone)) : 'automatique'} · ${fmtDate(r.created_at)}</span></li>`).join('')}</ul>
        <div class="myad-a"><a class="btn sm" href="/admin/conversations/${c.id}">👁 Lire la conversation</a>${form(req, `/admin/conversations/${c.id}/classer`, '👌 Classer sans suite')}</div></div>`;
    }).join('') || '<div class="empty">Aucune conversation signalée.</div>'}</div>`;
    res.send(adminPage(req, 'signalements', 'Signalements', body + cbody));
  });

  // --- conversations signalées ---
  const uLink = (id) => { const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id); return u ? `<a href="/admin/utilisateurs/${u.id}">${esc(u.display_name || 'Sans nom')}</a> (${esc(fmtPhone(u.phone))})${u.banned_at ? ' <span class="st st-bad">Banni</span>' : ''}` : '—'; };
  const participants = (c) => `Acheteur : ${uLink(c.buyer_id)} · Vendeur : ${uLink(c.seller_id)}`;
  const getReportedConv = (req, res) => {
    const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(req.params.id) || 0);
    if (!c) { res.redirect(303, '/admin/signalements?err=' + encodeURIComponent('Conversation introuvable')); return null; }
    if (!db.prepare('SELECT 1 FROM conversation_reports WHERE conversation_id = ?').get(c.id)) {
      res.status(403).send(adminPage(req, 'signalements', 'Accès refusé', '<p>Seules les conversations signalées peuvent être consultées par la modération.</p>')); return null;
    }
    return c;
  };
  app.get('/admin/conversations/:id', (req, res) => {
    const c = getReportedConv(req, res); if (!c) return;
    audit(req, 'conversation_lue', 'conversation', c.id, `« ${c.ad_title} »`);
    const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(c.id);
    const reps = db.prepare('SELECT * FROM conversation_reports WHERE conversation_id = ? ORDER BY created_at DESC').all(c.id);
    const open = reps.some((r) => r.status === 'open');
    const banBtn = (uid, label) => { const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); return u && !u.banned_at && u.role !== 'admin' ? reasonForm(req, `/admin/utilisateurs/${uid}/bannir`, label, 'Motif du bannissement') : ''; };
    const body = `<p><a href="/admin/signalements#conversations">← Signalements</a></p>
      <p class="small">${participants(c)}${c.ad_id ? ` · <a href="/annonce/${c.ad_id}">Voir l'annonce</a>` : ' · annonce supprimée'}${c.is_example ? ' · <span class="st st-wait">EXEMPLE</span>' : ''}</p>
      <ul class="rlist">${reps.map((r) => `<li><strong>${esc(r.reason)}</strong>${r.details ? ' — « ' + esc(r.details) + ' »' : ''} <span class="muted small">${fmtDate(r.created_at)} · ${r.status === 'open' ? 'ouvert' : r.status === 'dismissed' ? 'classé' : 'traité'}</span></li>`).join('')}</ul>
      <div class="bubbles admin-view">${msgs.map((m) => `<div class="bubble ${m.sender_id === c.seller_id ? 'me' : 'them'}"><div class="small"><strong>${m.sender_id === c.seller_id ? 'Vendeur' : 'Acheteur'}</strong></div><div class="btext">${esc(m.body)}</div>${m.flagged_words ? `<div class="small"><span class="st st-bad">Mots interdits</span> ${esc(m.flagged_words)}</div>` : ''}<div class="btime">${fmtDate(m.created_at)}</div></div>`).join('')}</div>
      <div class="myad-a">${open ? form(req, `/admin/conversations/${c.id}/classer`, '👌 Classer sans suite') : ''}
        ${banBtn(c.buyer_id, '⛔ Bannir l\'acheteur')}${banBtn(c.seller_id, '⛔ Bannir le vendeur')}
        ${form(req, `/admin/conversations/${c.id}/supprimer`, '🗑 Supprimer la conversation', 'btn-ghost danger')}</div>`;
    res.send(adminPage(req, 'signalements', `Conversation n° ${c.id} — ${c.ad_title}`, body));
  });
  app.post('/admin/conversations/:id/classer', (req, res) => {
    const c = getReportedConv(req, res); if (!c) return;
    const n = db.prepare("UPDATE conversation_reports SET status = 'dismissed', resolved_at = ?, resolved_by = ?, resolution = 'Classé sans suite' WHERE conversation_id = ? AND status = 'open'").run(now(), req.user.id, c.id).changes;
    audit(req, 'conversation_signalements_classes', 'conversation', c.id, `${n} signalement(s)`);
    go(res, back(req, '/admin/signalements'), 'Signalements de la conversation classés.');
  });
  app.post('/admin/conversations/:id/supprimer', (req, res) => {
    const c = getReportedConv(req, res); if (!c) return;
    const n = db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?').get(c.id).n;
    db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);
    audit(req, 'conversation_supprimee', 'conversation', c.id, `« ${c.ad_title} » — ${n} message(s) — acheteur n° ${c.buyer_id}, vendeur n° ${c.seller_id}`);
    go(res, '/admin/signalements', 'Conversation supprimée.');
  });
  const resolveReports = (req, adId, status, resolution) => db.prepare("UPDATE reports SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ? WHERE ad_id = ? AND status = 'open'").run(status, now(), req.user.id, resolution, adId).changes;
  app.post('/admin/signalements/:id/classer', (req, res) => {
    const n = resolveReports(req, Number(req.params.id), 'dismissed', 'Classé sans suite');
    audit(req, 'signalements_classes', 'annonce', Number(req.params.id), `${n} signalement(s)`);
    go(res, back(req, '/admin/signalements'), 'Signalements classés sans suite.');
  });

  // --- actions sur les annonces ---
  const getAd = (req, res) => { const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(Number(req.params.id) || 0); if (!ad) res.redirect(303, '/admin/annonces?err=' + encodeURIComponent('Annonce introuvable')); return ad; };
  app.post('/admin/annonces/:id/masquer', (req, res) => {
    const ad = getAd(req, res); if (!ad) return;
    const reason = String(req.body.reason || '').trim().slice(0, 200) || 'Masquée par la modération';
    db.prepare("UPDATE ads SET status = 'hidden', moderation_note = ? WHERE id = ?").run(reason, ad.id);
    resolveReports(req, ad.id, 'actioned', 'Annonce masquée');
    audit(req, 'annonce_masquee', 'annonce', ad.id, `« ${ad.title} » — ${reason}`);
    go(res, back(req, '/admin/annonces'), 'Annonce masquée.');
  });
  app.post('/admin/annonces/:id/retablir', (req, res) => {
    const ad = getAd(req, res); if (!ad) return;
    db.prepare("UPDATE ads SET status = 'active', moderation_note = NULL, flagged_words = NULL WHERE id = ?").run(ad.id);
    resolveReports(req, ad.id, 'dismissed', 'Annonce rétablie');
    audit(req, 'annonce_retablie', 'annonce', ad.id, `« ${ad.title} » (était : ${STATUS_FR[ad.status]})`);
    go(res, back(req, '/admin/annonces'), 'Annonce rétablie.');
  });
  app.post('/admin/annonces/:id/approuver', (req, res) => {
    const ad = getAd(req, res); if (!ad) return;
    db.prepare("UPDATE ads SET status = 'active', moderation_note = NULL, flagged_words = NULL WHERE id = ?").run(ad.id);
    audit(req, 'annonce_approuvee', 'annonce', ad.id, `« ${ad.title} »`);
    go(res, back(req, '/admin/moderation'), 'Annonce approuvée et publiée.');
  });
  app.post('/admin/annonces/:id/refuser', (req, res) => {
    const ad = getAd(req, res); if (!ad) return;
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    if (!reason) return res.redirect(303, '/admin/moderation?err=' + encodeURIComponent('Indiquez un motif de refus.'));
    db.prepare("UPDATE ads SET status = 'rejected', moderation_note = ? WHERE id = ?").run(reason, ad.id);
    audit(req, 'annonce_refusee', 'annonce', ad.id, `« ${ad.title} » — ${reason}`);
    go(res, back(req, '/admin/moderation'), 'Annonce refusée ; le motif est affiché au vendeur.');
  });
  app.post('/admin/annonces/:id/supprimer', (req, res) => {
    const ad = getAd(req, res); if (!ad) return;
    const reps = db.prepare('SELECT reason FROM reports WHERE ad_id = ?').all(ad.id).map((r) => r.reason);
    const photos = db.prepare('SELECT filename FROM photos WHERE ad_id = ?').all(ad.id);
    const seller = ad.user_id ? db.prepare('SELECT phone FROM users WHERE id = ?').get(ad.user_id)?.phone : null;
    db.prepare('DELETE FROM ads WHERE id = ?').run(ad.id);
    if (!ad.is_example) deletePhotoFiles(photos);
    audit(req, 'annonce_supprimee', 'annonce', ad.id, `« ${ad.title} » — vendeur ${seller || '—'} — ${reps.length} signalement(s)${reps.length ? ' : ' + [...new Set(reps)].join(', ') : ''}`);
    let to = back(req, '/admin/annonces'); if (to.startsWith('/annonce/')) to = '/admin/annonces';
    go(res, to, 'Annonce supprimée.');
  });

  // --- gestion des annonces ---
  app.get('/admin/annonces', (req, res) => {
    const f = { q: String(req.query.q || '').trim().slice(0, 100), cat: catBySlug[req.query.cat] ? req.query.cat : '', ville: C.CITIES.includes(req.query.ville) ? req.query.ville : '',
      statut: STATUSES.includes(req.query.statut) ? req.query.statut : '', tel: String(req.query.tel || '').trim(), id: parseInt(req.query.id, 10) || '' };
    const where = ['1=1']; const p = []; const t = now();
    if (f.id) { where.push('a.id = ?'); p.push(f.id); }
    if (f.q) for (const w of f.q.split(/\s+/).slice(0, 6)) { where.push('(a.title LIKE ? OR a.description LIKE ?)'); p.push(`%${w}%`, `%${w}%`); }
    if (f.cat) { where.push('a.category = ?'); p.push(f.cat); }
    if (f.ville) { where.push('a.city = ?'); p.push(f.ville); }
    if (f.statut === 'expired') { where.push("a.status = 'active' AND a.expires_at <= ?"); p.push(t); }
    else if (f.statut === 'active') { where.push("a.status = 'active' AND a.expires_at > ?"); p.push(t); }
    else if (f.statut) { where.push('a.status = ?'); p.push(f.statut); }
    if (f.tel) { const l = normPhone(f.tel); const digits = f.tel.replace(/\D/g, ''); where.push('(a.phone LIKE ? OR u.phone LIKE ?)'); p.push(`%${l || digits}%`, `%${l || digits}%`); }
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1);
    const total = db.prepare(`SELECT COUNT(*) n FROM ads a LEFT JOIN users u ON u.id = a.user_id WHERE ${where.join(' AND ')}`).get(...p).n;
    const ads = db.prepare(`SELECT a.* FROM ads a LEFT JOIN users u ON u.id = a.user_id WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT 30 OFFSET ${(pg - 1) * 30}`).all(...p);
    const qs = (over) => '/admin/annonces?' + new URLSearchParams(Object.entries({ ...f, ...over }).filter(([, v]) => v !== '' && v != null)).toString();
    const body = `<form class="fform afilter" method="get" action="/admin/annonces">
      <input type="search" name="q" value="${esc(f.q)}" placeholder="Mot-clé">
      <input type="tel" name="tel" value="${esc(f.tel)}" placeholder="Téléphone du vendeur">
      <div class="two"><select name="cat"><option value="">Toutes catégories</option>${C.CATEGORIES.map((c) => `<option value="${c.slug}" ${f.cat === c.slug ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select name="ville"><option value="">Toutes villes</option>${C.CITIES.map((c) => `<option ${f.ville === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="two"><select name="statut"><option value="">Tous statuts</option>${STATUSES.map((s) => `<option value="${s}" ${f.statut === s ? 'selected' : ''}>${s === 'expired' ? 'Expirée' : STATUS_FR[s]}</option>`).join('')}</select>
      <button class="btn" type="submit">Filtrer</button></div></form>
      <p class="muted small">${total} annonce${total > 1 ? 's' : ''}</p>
      <div class="mylist">${ads.map((a) => adLine(req, a)).join('') || '<div class="empty">Aucune annonce.</div>'}</div>
      ${total > pg * 30 || pg > 1 ? `<nav class="pager">${pg > 1 ? `<a class="btn btn-ghost" href="${qs({ page: pg - 1 })}">←</a>` : '<span></span>'}<span>Page ${pg}</span>${total > pg * 30 ? `<a class="btn btn-ghost" href="${qs({ page: pg + 1 })}">→</a>` : '<span></span>'}</nav>` : ''}`;
    res.send(adminPage(req, 'annonces', 'Annonces', body));
  });

  // --- pré-modération + réglages ---
  app.get('/admin/moderation', (req, res) => {
    const ads = db.prepare("SELECT * FROM ads WHERE status = 'pending' ORDER BY created_at ASC").all();
    const premod = db.getSetting('premoderation') === '1';
    const body = `<p class="small muted">Annonces en attente de validation (pré-modération ou mots interdits détectés).</p>
    <div class="mylist">${ads.map((a) => adLine(req, a)).join('') || '<div class="empty">Aucune annonce en attente.</div>'}</div>
    <h2 class="h2" id="reglages">Réglages de modération</h2>
    <form class="pform" method="post" action="/admin/reglages">${csrfField(req)}
      <label class="check"><input type="checkbox" name="premoderation" value="1" ${premod ? 'checked' : ''}> Pré-modération : les nouvelles annonces restent « en attente » jusqu'à validation</label>
      <label>Mots interdits (un par ligne ou séparés par des virgules ; sans tenir compte des accents ni des majuscules)
        <textarea name="banned_words" rows="6" placeholder="ex : arnaque&#10;faux billets">${esc(db.getSetting('banned_words'))}</textarea></label>
      <label>Si une annonce contient un mot interdit<select name="banned_words_action">
        <option value="pending" ${db.getSetting('banned_words_action') === 'pending' ? 'selected' : ''}>La mettre en attente de validation</option>
        <option value="reject" ${db.getSetting('banned_words_action') === 'reject' ? 'selected' : ''}>La refuser automatiquement</option></select></label>
      <button class="btn" type="submit">Enregistrer les réglages</button></form>`;
    res.send(adminPage(req, 'moderation', 'À valider', body));
  });
  app.post('/admin/reglages', (req, res) => {
    const premod = req.body.premoderation === '1' ? '1' : '0';
    const words = [...new Set(String(req.body.banned_words || '').split(/[\n,]+/).map((w) => w.trim().toLowerCase()).filter(Boolean))].slice(0, 500).join('\n');
    const action = req.body.banned_words_action === 'reject' ? 'reject' : 'pending';
    const changes = [];
    if (premod !== db.getSetting('premoderation')) changes.push(`pré-modération ${premod === '1' ? 'activée' : 'désactivée'}`);
    if (words !== db.getSetting('banned_words')) changes.push(`mots interdits : ${words.split('\n').filter(Boolean).length}`);
    if (action !== db.getSetting('banned_words_action')) changes.push(`action mots interdits : ${action === 'reject' ? 'refus' : 'attente'}`);
    db.setSetting('premoderation', premod); db.setSetting('banned_words', words); db.setSetting('banned_words_action', action);
    if (changes.length) audit(req, 'reglages_modifies', 'reglages', null, changes.join(' ; '));
    go(res, '/admin/moderation#reglages', 'Réglages enregistrés.');
  });

  // --- utilisateurs ---
  app.get('/admin/utilisateurs', (req, res) => {
    const q = String(req.query.q || '').trim(); const bannedOnly = req.query.filtre === 'bannis';
    const where = ['1=1']; const p = [];
    if (q) { const l = normPhone(q); where.push('(u.phone LIKE ? OR u.display_name LIKE ?)'); p.push(`%${l || q.replace(/\D/g, '') || q}%`, `%${q}%`); }
    if (bannedOnly) where.push('u.banned_at IS NOT NULL');
    const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM ads WHERE user_id = u.id) n_ads,
      (SELECT COUNT(*) FROM reports r JOIN ads a ON a.id = r.ad_id WHERE a.user_id = u.id AND r.status = 'open') n_rep
      FROM users u WHERE ${where.join(' AND ')} ORDER BY u.created_at DESC LIMIT 100`).all(...p);
    const body = `<form class="fform afilter" method="get" action="/admin/utilisateurs"><div class="two">
      <input type="search" name="q" value="${esc(q)}" placeholder="Téléphone ou nom"><button class="btn" type="submit">Rechercher</button></div>
      <label class="check"><input type="checkbox" name="filtre" value="bannis" ${bannedOnly ? 'checked' : ''} onchange="this.form.submit()"> Bannis uniquement</label></form>
      <div class="mylist">${users.map((u) => `<a class="urow" href="/admin/utilisateurs/${u.id}"><span class="avatar sm">${u.display_name ? esc(Array.from(u.display_name)[0].toUpperCase()) : '👤'}</span>
        <span class="urow-b"><strong>${esc(u.display_name || 'Sans nom')}</strong> ${u.role === 'admin' ? '<span class="st st-ok">Admin</span>' : ''}${u.banned_at ? '<span class="st st-bad">Banni</span>' : ''}${u.is_demo ? '<span class="st st-sold">Démo</span>' : ''}<br>
        <span class="small muted">${esc(fmtPhone(u.phone))} · ${u.n_ads} annonce${u.n_ads > 1 ? 's' : ''}${u.n_rep ? ` · <span class="st st-bad">${u.n_rep} signalement${u.n_rep > 1 ? 's' : ''}</span>` : ''} · inscrit ${fmtDate(u.created_at).toLowerCase()}</span></span><span>›</span></a>`).join('') || '<div class="empty">Aucun utilisateur.</div>'}</div>`;
    res.send(adminPage(req, 'utilisateurs', 'Utilisateurs', body));
  });
  app.get('/admin/utilisateurs/:id', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id) || 0);
    if (!u) return res.redirect(303, '/admin/utilisateurs?err=' + encodeURIComponent('Utilisateur introuvable'));
    const ads = db.prepare('SELECT * FROM ads WHERE user_id = ? ORDER BY created_at DESC').all(u.id);
    const recv = db.prepare('SELECT r.*, a.title FROM reports r JOIN ads a ON a.id = r.ad_id WHERE a.user_id = ? ORDER BY r.created_at DESC LIMIT 50').all(u.id);
    const sent = db.prepare('SELECT r.*, a.title FROM reports r LEFT JOIN ads a ON a.id = r.ad_id WHERE r.reporter_id = ? ORDER BY r.created_at DESC LIMIT 50').all(u.id);
    const rep = (r) => `<li><strong>${esc(r.reason)}</strong> — <a href="/annonce/${r.ad_id}">${esc(r.title || 'n° ' + r.ad_id)}</a>${r.details ? ' « ' + esc(r.details) + ' »' : ''} <span class="small muted">${fmtDate(r.created_at)} · ${r.status === 'open' ? 'ouvert' : r.status === 'dismissed' ? 'classé' : 'traité'}</span></li>`;
    const self = u.id === req.user.id;
    const body = `<p><a href="/admin/utilisateurs">← Tous les utilisateurs</a></p>
    <div class="ucard"><span class="avatar">${u.display_name ? esc(Array.from(u.display_name)[0].toUpperCase()) : '👤'}</span><div>
      <strong>${esc(u.display_name || 'Sans nom')}</strong> ${u.role === 'admin' ? '<span class="st st-ok">Admin</span>' : ''}${u.is_demo ? ' <span class="st st-sold">Démo</span>' : ''}<br>
      <span class="muted">${esc(fmtPhone(u.phone))} · inscrit le ${new Date(u.created_at).toLocaleDateString('fr-FR', { timeZone: 'Africa/Brazzaville' })}${u.last_login_at ? ' · dernière connexion ' + fmtDate(u.last_login_at).toLowerCase() : ''}</span></div></div>
    ${u.banned_at ? `<div class="notice bad">⛔ Compte banni ${fmtDate(u.banned_at).toLowerCase()}${u.ban_reason ? ' — motif : ' + esc(u.ban_reason) : ''}. Ses annonces sont masquées et il ne peut plus se connecter.</div>${form(req, `/admin/utilisateurs/${u.id}/debannir`, '✅ Lever le bannissement', '')}`
      : self || u.role === 'admin' ? '<p class="small muted">Les administrateurs ne peuvent pas être bannis depuis le panneau (retirez d\'abord le rôle avec <code>npm run admin -- demote</code>).</p>'
      : reasonForm(req, `/admin/utilisateurs/${u.id}/bannir`, '⛔ Bannir cet utilisateur', 'Motif du bannissement')}
    <h2 class="h2">Annonces (${ads.length})</h2><div class="mylist">${ads.map((a) => adLine(req, a)).join('') || '<p class="muted">Aucune annonce.</p>'}</div>
    <h2 class="h2">Signalements reçus (${recv.length})</h2><ul class="rlist">${recv.map(rep).join('') || '<li class="muted">Aucun.</li>'}</ul>
    <h2 class="h2">Signalements envoyés (${sent.length})</h2><ul class="rlist">${sent.map(rep).join('') || '<li class="muted">Aucun.</li>'}</ul>`;
    res.send(adminPage(req, 'utilisateurs', 'Utilisateur', body));
  });
  app.post('/admin/utilisateurs/:id/bannir', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id) || 0);
    if (!u) return res.redirect(303, '/admin/utilisateurs');
    if (u.role === 'admin') return res.redirect(303, `/admin/utilisateurs/${u.id}?err=` + encodeURIComponent('Impossible de bannir un administrateur.'));
    const reason = String(req.body.reason || '').trim().slice(0, 200) || 'Non respect des règles';
    db.prepare('UPDATE users SET banned_at = ?, ban_reason = ? WHERE id = ?').run(now(), reason, u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    db.prepare("UPDATE reports SET status = 'actioned', resolved_at = ?, resolved_by = ?, resolution = 'Vendeur banni' WHERE status = 'open' AND ad_id IN (SELECT id FROM ads WHERE user_id = ?)").run(now(), req.user.id, u.id);
    db.prepare("UPDATE conversation_reports SET status = 'actioned', resolved_at = ?, resolved_by = ?, resolution = 'Participant banni' WHERE status = 'open' AND conversation_id IN (SELECT id FROM conversations WHERE buyer_id = ? OR seller_id = ?)").run(now(), req.user.id, u.id, u.id);
    audit(req, 'utilisateur_banni', 'utilisateur', u.id, `${u.phone} — ${reason}`);
    go(res, back(req, `/admin/utilisateurs/${u.id}`), 'Utilisateur banni : ses annonces sont masquées et il est déconnecté.');
  });
  app.post('/admin/utilisateurs/:id/debannir', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id) || 0);
    if (!u) return res.redirect(303, '/admin/utilisateurs');
    db.prepare('UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE id = ?').run(u.id);
    audit(req, 'utilisateur_debanni', 'utilisateur', u.id, u.phone);
    go(res, back(req, `/admin/utilisateurs/${u.id}`), 'Bannissement levé.');
  });

  // --- paiements ---
  const pay = require('./payments');
  const TST = { pending: 'En attente', success: 'Payé', failed: 'Échoué', expired: 'Expiré', refunded: 'Remboursé' };
  const TSTC = { pending: 'st-wait', success: 'st-ok', failed: 'st-bad', expired: 'st-sold', refunded: 'st-sold' };
  app.get('/admin/paiements', (req, res) => {
    const f = { statut: TST[req.query.statut] ? req.query.statut : '', op: pay.OPERATORS[req.query.op] ? req.query.op : '', q: String(req.query.q || '').trim().slice(0, 60), jours: [1, 7, 30, 365].includes(Number(req.query.jours)) ? Number(req.query.jours) : '' };
    const where = ['1=1']; const p = [];
    if (f.statut) { where.push('t.status = ?'); p.push(f.statut); }
    if (f.op) { where.push('t.operator = ?'); p.push(f.op); }
    if (f.jours) { where.push('t.created_at >= ?'); p.push(now() - f.jours * DAY); }
    if (f.q) { const l = normPhone(f.q); where.push('(t.ref LIKE ? OR t.payer_phone LIKE ? OR t.provider_ref LIKE ? OR u.phone LIKE ?)'); const x = `%${l || f.q}%`; p.push(`%${f.q}%`, x, `%${f.q}%`, x); }
    const W = where.join(' AND ');
    const rows = db.prepare(`SELECT t.*, u.phone user_phone, u.display_name FROM transactions t LEFT JOIN users u ON u.id = t.user_id WHERE ${W} ORDER BY t.created_at DESC LIMIT 200`).all(...p);
    const tot = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN t.status = 'success' AND t.is_example = 0 THEN t.amount END),0) paid FROM transactions t LEFT JOIN users u ON u.id = t.user_id WHERE ${W}`).get(...p);
    const body = `<form class="fform afilter" method="get" action="/admin/paiements">
      <input type="search" name="q" value="${esc(f.q)}" placeholder="Référence, téléphone, réf. opérateur">
      <div class="two"><select name="statut"><option value="">Tous statuts</option>${Object.entries(TST).map(([k, l]) => `<option value="${k}" ${f.statut === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select name="op"><option value="">Tous opérateurs</option>${Object.values(pay.OPERATORS).map((o) => `<option value="${o.code}" ${f.op === o.code ? 'selected' : ''}>${o.name}</option>`).join('')}</select></div>
      <div class="two"><select name="jours"><option value="">Toute période</option>${[[1, "24 h"], [7, '7 jours'], [30, '30 jours'], [365, '1 an']].map(([d, l]) => `<option value="${d}" ${f.jours === d ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn" type="submit">Filtrer</button></div></form>
      <p class="small">${tot.n} paiement${tot.n > 1 ? 's' : ''} · encaissé (hors exemples) : <strong>${fmtPrice(tot.paid).replace('Prix à discuter', '0 FCFA')}</strong> · mode : <strong>${pay.isDev ? 'simulation (test)' : 'réel'}</strong></p>
      <div class="mylist">${rows.map((t) => `<div class="logrow" id="tx-${t.id}"><div><strong>${fmtPrice(t.amount)}</strong> — ${esc(t.product_name)} <span class="st ${TSTC[t.status]}">${TST[t.status]}</span>${t.is_example ? ' <span class="st st-wait">EXEMPLE</span>' : ''}</div>
        <div class="small muted">${fmtDate(t.created_at)} · ${pay.OPERATORS[t.operator].name} ${esc(fmtPhone(t.payer_phone))} · compte ${t.user_id ? `<a href="/admin/utilisateurs/${t.user_id}">${esc(t.display_name || fmtPhone(t.user_phone || ''))}</a>` : '—'} · annonce ${t.ad_id ? `<a href="/annonce/${t.ad_id}">${esc(t.ad_title || '')}</a>` : esc(t.ad_title || '—')}</div>
        <div class="small muted">Réf. <code>${esc(t.ref)}</code>${t.provider_ref ? ` · opérateur <code>${esc(t.provider_ref)}</code>` : ''}${t.failure_reason ? ' · ' + esc(t.failure_reason) : ''}${t.refund_note ? ' · remboursement : ' + esc(t.refund_note) : ''}</div>
        ${t.status === 'success' ? `<div class="myad-a">${reasonForm(req, `/admin/paiements/${t.id}/rembourser`, '↩ Marquer remboursé', 'Note (ex. remboursé par MoMo le …, réf. …)', 'btn-ghost')}</div>` : ''}</div>`).join('') || '<div class="empty">Aucun paiement.</div>'}</div>`;
    res.send(adminPage(req, 'paiements', 'Paiements', body));
  });
  app.post('/admin/paiements/:id/rembourser', (req, res) => {
    const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(req.params.id) || 0);
    if (!t || t.status !== 'success') return res.redirect(303, '/admin/paiements?err=' + encodeURIComponent('Seul un paiement réussi peut être marqué remboursé.'));
    const note = String(req.body.reason || '').trim().slice(0, 200);
    db.prepare("UPDATE transactions SET status = 'refunded', refunded_at = ?, refunded_by = ?, refund_note = ?, updated_at = ? WHERE id = ? AND status = 'success'").run(now(), req.user.id, note, now(), t.id);
    // retire la durée achetée (le boost s'arrête s'il n'en reste rien)
    const col = t.product_code === 'une' ? 'featured_until' : t.product_code === 'urgent' ? 'urgent_until' : null;
    if (col && t.ad_id) db.prepare(`UPDATE ads SET ${col} = ${col} - ? WHERE id = ? AND ${col} IS NOT NULL`).run(t.duration_days * DAY, t.ad_id);
    audit(req, 'paiement_rembourse', 'paiement', t.id, `${t.product_name} — ${t.amount} FCFA — ${t.payer_phone}${note ? ' — ' + note : ''}${col ? ' — boost retiré' : ''}`);
    go(res, back(req, '/admin/paiements'), 'Paiement marqué remboursé (le remboursement lui-même se fait via l\'opérateur).');
  });
  // --- tarifs des boosts ---
  app.get('/admin/boosts', (req, res) => {
    const ps = db.prepare('SELECT * FROM boost_products ORDER BY sort').all();
    const body = `<p class="small muted">Prix en FCFA, appliqués aux nouveaux paiements (les paiements en cours gardent leur prix).</p>
    <form class="pform" method="post" action="/admin/boosts">${csrfField(req)}${ps.map((p) => `<fieldset><legend>${esc(p.code === 'une' ? '⭐' : p.code === 'urgent' ? '🔥' : '⬆️')} ${esc(p.name)}</legend>
      <label>Nom affiché<input name="name_${p.code}" maxlength="40" required value="${esc(p.name)}"></label>
      <label>Description<textarea name="desc_${p.code}" rows="2" maxlength="200">${esc(p.description)}</textarea></label>
      <div class="two"><label>Prix (FCFA)<input name="price_${p.code}" type="number" inputmode="numeric" min="100" max="1000000" step="50" required value="${p.price}"></label>
      ${p.code === 'remonter' ? '<span></span>' : `<label>Durée (jours)<input name="days_${p.code}" type="number" min="1" max="90" required value="${p.duration_days}"></label>`}</div>
      <label class="check"><input type="checkbox" name="active_${p.code}" value="1" ${p.active ? 'checked' : ''}> Proposé aux vendeurs</label></fieldset>`).join('')}
      <button class="btn" type="submit">Enregistrer les tarifs</button></form>`;
    res.send(adminPage(req, 'boosts', 'Tarifs des boosts', body));
  });
  app.post('/admin/boosts', (req, res) => {
    const ps = db.prepare('SELECT * FROM boost_products ORDER BY sort').all(); const changes = [];
    for (const p of ps) {
      const price = parseInt(req.body['price_' + p.code], 10); const days = p.code === 'remonter' ? 0 : parseInt(req.body['days_' + p.code], 10);
      if (!(price >= 100 && price <= 1000000) || !(p.code === 'remonter' || (days >= 1 && days <= 90))) return res.redirect(303, '/admin/boosts?err=' + encodeURIComponent('Prix (100 à 1 000 000 FCFA) ou durée (1 à 90 jours) invalide pour « ' + p.name + ' ».'));
      const n = { name: String(req.body['name_' + p.code] || p.name).trim().slice(0, 40) || p.name, description: String(req.body['desc_' + p.code] ?? p.description).trim().slice(0, 200), price, duration_days: days, active: req.body['active_' + p.code] === '1' ? 1 : 0 };
      const diff = Object.keys(n).filter((k) => n[k] !== p[k]).map((k) => k === 'price' ? `prix ${p.price} → ${price} FCFA` : k === 'duration_days' ? `durée ${p.duration_days} → ${days} j` : k === 'active' ? (n.active ? 'activé' : 'désactivé') : k);
      if (diff.length) { db.prepare('UPDATE boost_products SET name = ?, description = ?, price = ?, duration_days = ?, active = ? WHERE code = ?').run(n.name, n.description, n.price, n.duration_days, n.active, p.code); changes.push(`${p.name} : ${diff.join(', ')}`); }
    }
    if (changes.length) audit(req, 'tarifs_modifies', 'tarifs', null, changes.join(' ; '));
    go(res, '/admin/boosts', changes.length ? 'Tarifs enregistrés.' : 'Aucun changement.');
  });

  // --- journal ---
  const ACTIONS_FR = { annonce_masquee: 'Annonce masquée', annonce_retablie: 'Annonce rétablie', annonce_approuvee: 'Annonce approuvée', annonce_refusee: 'Annonce refusée', annonce_supprimee: 'Annonce supprimée',
    signalements_classes: 'Signalements classés', utilisateur_banni: 'Utilisateur banni', utilisateur_debanni: 'Bannissement levé', reglages_modifies: 'Réglages modifiés',
    auto_masquage: 'Masquage automatique', mots_interdits: 'Mots interdits détectés', role_admin: 'Rôle administrateur modifié',
    conversation_lue: 'Conversation signalée consultée', conversation_signalements_classes: 'Signalements de conversation classés', conversation_supprimee: 'Conversation supprimée', message_mots_interdits: 'Message avec mots interdits',
    paiement_confirme: 'Paiement confirmé (boost activé)', paiement_rembourse: 'Paiement marqué remboursé', tarifs_modifies: 'Tarifs des boosts modifiés' };
  app.get('/admin/alertes', (req, res) => res.send(alerts.adminAlerts(req, adminPage)));
  app.get('/admin/journal', (req, res) => {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rows = db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 100 OFFSET ${(pg - 1) * 100}`).all();
    const link = (r) => (r.target_type === 'annonce' ? `<a href="/admin/annonces?id=${r.target_id}">annonce n° ${r.target_id}</a>` : r.target_type === 'paiement' ? `<a href="/admin/paiements#tx-${r.target_id}">paiement n° ${r.target_id}</a>` : r.target_type === 'conversation' ? `<a href="/admin/conversations/${r.target_id}">conversation n° ${r.target_id}</a>` : r.target_type === 'utilisateur' ? `<a href="/admin/utilisateurs/${r.target_id}">utilisateur n° ${r.target_id}</a>` : esc(r.target_type || ''));
    const body = `<p class="small muted">Toutes les actions de modération (qui, quoi, quand). Les actions automatiques apparaissent comme « système ».</p>
    <div class="mylist">${rows.map((r) => `<div class="logrow"><div><strong>${esc(ACTIONS_FR[r.action] || r.action)}</strong> — ${link(r)}</div>
      <div class="small muted">${fmtDate(r.created_at)} · par ${r.admin_phone === 'système' ? 'système' : esc(fmtPhone(r.admin_phone))}${r.details ? ' · ' + esc(r.details) : ''}</div></div>`).join('') || '<div class="empty">Journal vide.</div>'}</div>
    ${rows.length === 100 ? `<a class="btn btn-ghost" href="/admin/journal?page=${pg + 1}">Plus ancien →</a>` : ''}`;
    res.send(adminPage(req, 'journal', 'Journal des actions', body));
  });
};
