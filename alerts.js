// Alertes SMS / WhatsApp « nouveau message » + page Mon compte › Notifications.
// File d'attente en base (table alerts) traitée par un petit planificateur en mémoire : survit aux redémarrages.
// Règles : alerte seulement si le message est encore non lu après ALERT_DELAY_SEC (120 s) ; une alerte par conversation
// toutes les ALERT_THROTTLE_MIN (30 min) (les messages suivants sont regroupés) ; ALERT_DAILY_CAP (10) alertes / 24 h par
// utilisateur ; rien pour un destinataire / expéditeur banni ni un expéditeur bloqué ; heures calmes (22 h – 7 h, Brazzaville)
// activées par défaut : l'alerte est alors reportée à 7 h. Le texte ne contient jamais le contenu du message.
const auth = require('./auth');
const sms = require('./sms');
const wa = require('./whatsapp');

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const CFG = {
  delay: num(process.env.ALERT_DELAY_SEC, 120) * 1000,
  throttle: num(process.env.ALERT_THROTTLE_MIN, 30) * 60000,
  cap: num(process.env.ALERT_DAILY_CAP, 10),
  tick: num(process.env.ALERT_TICK_SEC, 15) * 1000,
};
const TZ_OFF = 3600000; // Africa/Brazzaville = UTC+1, sans heure d'été
const HOUR = 3600000, DAY = 86400000;
const CHANNELS = { sms: '📱 SMS', whatsapp: '🟢 WhatsApp', none: '🔕 Aucune' };
const STATUS_FR = { queued: 'En attente', sending: 'Envoi…', sent: 'Envoyée', failed: 'Échec', skipped: 'Non envoyée' };

// SMS : rester dans l'alphabet GSM 7 bits (160 caractères / SMS ; un seul caractère hors GSM => 70 caractères / SMS)
const GSM = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(''));
const toGsm = (s) => Array.from(String(s).replace(/[«»“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/…/g, '...'))
  .map((c) => (GSM.has(c) ? c : c.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))).filter((c) => GSM.has(c)).join('');
const cut = (s, n) => { const a = Array.from(String(s || '').trim()); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
const brzHour = (t) => new Date(t + TZ_OFF).getUTCHours();

module.exports = function mountAlerts(app, h) {
  const { db, C, esc, layout, csrfField, fmtDate, fmtPhone, requireUser } = h;
  const quietWindow = () => { const m = /^(\d{1,2})-(\d{1,2})$/.exec(db.getSetting('alert_quiet_hours') || '22-7'); return m ? [Number(m[1]) % 24, Number(m[2]) % 24] : [22, 7]; };
  const inQuiet = (t) => { const [s, e] = quietWindow(); const hh = brzHour(t); return s > e ? hh >= s || hh < e : hh >= s && hh < e; };
  const quietEnd = (t) => { const [, e] = quietWindow(); let x = Math.floor((t + TZ_OFF) / DAY) * DAY - TZ_OFF + e * HOUR; while (x <= t) x += DAY; return x; };
  const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

  // Appelé après l'enregistrement d'un message
  function onMessage(req, conv, senderId) {
    const toId = conv.buyer_id === senderId ? conv.seller_id : conv.buyer_id;
    const to = db.prepare('SELECT * FROM users WHERE id = ?').get(toId);
    if (!to || to.notify_channel === 'none') return;
    if (db.prepare("SELECT 1 FROM alerts WHERE user_id = ? AND conversation_id = ? AND status IN ('queued','sending')").get(toId, conv.id)) return; // déjà en file : regroupé
    const now = Date.now();
    db.prepare('INSERT INTO alerts (user_id, conversation_id, sender_id, link, due_at, created_at) VALUES (?,?,?,?,?,?)').run(toId, conv.id, senderId, `${baseUrl(req)}/messages/${conv.id}`, now + CFG.delay, now);
  }

  const upd = db.prepare('UPDATE alerts SET status = ?, reason = ?, due_at = COALESCE(?, due_at), sent_at = COALESCE(?, sent_at), channel = COALESCE(?, channel), provider = COALESCE(?, provider), to_phone = COALESCE(?, to_phone), body = COALESCE(?, body) WHERE id = ?');
  const set = (a, status, reason, o = {}) => upd.run(status, reason || null, o.due ?? null, o.sent ?? null, o.channel ?? null, o.provider ?? null, o.to ?? null, o.body ?? null, a.id);
  async function processOne(a) {
    const now = Date.now();
    const to = db.prepare('SELECT * FROM users WHERE id = ?').get(a.user_id);
    const from = a.sender_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(a.sender_id) : null;
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(a.conversation_id);
    if (!to || !conv) return set(a, 'skipped', 'Conversation ou compte supprimé');
    if (to.banned_at) return set(a, 'skipped', 'Destinataire banni');
    if (!from || from.banned_at) return set(a, 'skipped', 'Expéditeur banni ou supprimé');
    if (db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(to.id, from.id)) return set(a, 'skipped', 'Expéditeur bloqué par le destinataire');
    if (to.notify_channel === 'none') return set(a, 'skipped', 'Alertes désactivées par le destinataire');
    const lastRead = conv.buyer_id === to.id ? conv.buyer_last_read : conv.seller_last_read;
    if (!db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND sender_id != ? AND id > ?').get(conv.id, to.id, lastRead || 0)) return set(a, 'skipped', 'Message déjà lu');
    if (to.quiet_hours && inQuiet(now)) return set(a, 'queued', 'Heures calmes : reportée', { due: quietEnd(now) });
    const last = db.prepare("SELECT MAX(sent_at) t FROM alerts WHERE user_id = ? AND conversation_id = ? AND status = 'sent'").get(to.id, conv.id).t;
    if (last && last > now - CFG.throttle) return set(a, 'queued', `Regroupée (1 alerte / ${Math.round(CFG.throttle / 60000)} min par conversation)`, { due: last + CFG.throttle });
    if (db.prepare("SELECT COUNT(*) n FROM alerts WHERE user_id = ? AND status = 'sent' AND sent_at > ?").get(to.id, now - DAY).n >= CFG.cap) return set(a, 'skipped', `Plafond quotidien atteint (${CFG.cap} / 24 h)`);
    if (db.prepare("UPDATE alerts SET status = 'sending' WHERE id = ? AND status = 'queued'").run(a.id).changes !== 1) return; // déjà pris
    const name = cut(from.display_name || (conv.buyer_id === from.id ? 'un acheteur' : 'le vendeur'), 20);
    const title = cut(conv.ad_title, 40);
    const channel = to.notify_channel === 'whatsapp' ? 'whatsapp' : 'sms';
    let text = `${C.BRAND} : nouveau message de ${name} à propos de « ${title} ». Répondez : ${a.link}`;
    if (channel === 'sms') text = toGsm(text);
    const provider = channel === 'sms' ? sms.name : wa.name;
    try {
      if (channel === 'sms') await sms.send(to.phone, text); else await wa.send(to.phone, { text, params: [name, title, a.link] });
      set(a, 'sent', provider === 'dev' ? 'Mode test : non envoyée réellement' : null, { sent: Date.now(), channel, provider, to: to.phone, body: text });
    } catch (e) {
      console.error('Alerte', a.id, e.message);
      set(a, 'failed', String(e.message).slice(0, 200), { channel, provider, to: to.phone, body: text });
    }
  }
  let running = false;
  async function tick() {
    if (running) return; running = true;
    try {
      db.prepare("UPDATE alerts SET status = 'queued' WHERE status = 'sending' AND created_at < ?").run(Date.now() - HOUR); // envoi interrompu par un redémarrage
      for (const a of db.prepare("SELECT * FROM alerts WHERE status = 'queued' AND due_at <= ? ORDER BY due_at LIMIT 50").all(Date.now())) await processOne(a);
    } catch (e) { console.error('Alertes', e.message); } finally { running = false; }
  }
  setInterval(tick, CFG.tick).unref(); setTimeout(tick, 2000).unref();

  // --- Mon compte › Notifications ---
  function settingsPage(req, saved) {
    const u = req.user; const [qs, qe] = quietWindow();
    return layout(req, { title: 'Notifications', body: `<div class="auth"><p class="small muted"><a href="/mes-annonces">Mon compte</a> › Notifications</p>
      <h1 class="h1">🔔 Notifications</h1>${saved ? '<div class="notice ok">Préférences enregistrées.</div>' : ''}
      <p class="muted">Quand quelqu'un vous écrit sur ${esc(C.BRAND)} et que vous n'avez pas lu son message après quelques minutes, nous vous prévenons.
      L'alerte ne contient jamais le texte du message, seulement le nom de l'expéditeur, l'annonce et un lien pour répondre.</p>
      <form method="post" action="/compte/notifications" class="pform">${csrfField(req)}
        <fieldset><legend>Recevoir les alertes de nouveaux messages par</legend><div class="opts">
        ${[['sms', 'Par SMS au ' + fmtPhone(u.phone)], ['whatsapp', 'Sur WhatsApp au ' + fmtPhone(u.phone) + ' (le numéro doit avoir WhatsApp)'], ['none', 'Pas d\'alerte : je consulte Messages moi-même']].map(([k, d]) => `
          <label class="opt"><input type="radio" name="channel" value="${k}" ${u.notify_channel === k ? 'checked' : ''}><span class="opt-b"><span class="opt-t">${CHANNELS[k]}</span><span class="small muted">${esc(d)}</span></span></label>`).join('')}
        </div></fieldset>
        <label class="opt" style="margin-top:12px"><input type="checkbox" name="quiet" value="1" ${u.quiet_hours ? 'checked' : ''}><span class="opt-b"><span class="opt-t">🌙 Heures calmes</span>
          <span class="small muted">Pas d'alerte entre ${qs} h et ${qe} h (heure de Brazzaville) : elle arrive le matin.</span></span></label>
        <p class="small muted">Au plus une alerte par conversation toutes les ${Math.round(CFG.throttle / 60000)} minutes et ${CFG.cap} alertes par jour. Les alertes sont gratuites pour vous.</p>
        <button class="btn" type="submit" style="width:100%">Enregistrer</button></form></div>` });
  }
  app.get('/compte/notifications', requireUser, (req, res) => res.send(settingsPage(req, req.query.ok)));
  app.post('/compte/notifications', requireUser, auth.csrfGuard, (req, res) => {
    const ch = CHANNELS[req.body.channel] ? req.body.channel : 'sms';
    db.prepare('UPDATE users SET notify_channel = ?, quiet_hours = ? WHERE id = ?').run(ch, req.body.quiet ? 1 : 0, req.user.id);
    if (ch === 'none') db.prepare("UPDATE alerts SET status = 'skipped', reason = 'Alertes désactivées par le destinataire' WHERE user_id = ? AND status = 'queued'").run(req.user.id);
    res.redirect(303, '/compte/notifications?ok=1');
  });

  // --- Admin › Alertes envoyées (la protection /admin est montée par admin.js) ---
  function adminAlerts(req, adminPage) {
    const st = STATUS_FR[req.query.statut] ? req.query.statut : '';
    const rows = db.prepare(`SELECT a.*, u.display_name to_name, u.phone u_phone, s.display_name from_name, c.ad_title FROM alerts a LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN users s ON s.id = a.sender_id LEFT JOIN conversations c ON c.id = a.conversation_id ${st ? 'WHERE a.status = ?' : ''} ORDER BY a.id DESC LIMIT 200`).all(...(st ? [st] : []));
    const cnt = Object.fromEntries(db.prepare('SELECT status k, COUNT(*) n FROM alerts WHERE created_at > ? GROUP BY status').all(Date.now() - DAY).map((r) => [r.k, r.n]));
    const cls = { queued: 'st-wait', sending: 'st-wait', sent: 'st-ok', failed: 'st-bad', skipped: 'st-sold' };
    const [qs, qe] = quietWindow();
    const body = `<p class="small">Fournisseurs : SMS <strong>${esc(sms.name)}</strong> · WhatsApp <strong>${esc(wa.name)}</strong>${sms.isDev || wa.isDev ? ' — <span class="st st-wait">Mode test</span> : les alertes « dev » sont seulement enregistrées ici et dans les logs, rien n\'est réellement envoyé.' : ''}</p>
      <p class="small muted">Délai avant alerte : ${Math.round(CFG.delay / 1000)} s · 1 alerte / ${Math.round(CFG.throttle / 60000)} min par conversation · ${CFG.cap} / 24 h par utilisateur · heures calmes ${qs} h – ${qe} h.</p>
      <div class="stats">${['sent', 'queued', 'skipped', 'failed'].map((k) => `<a class="stat" href="/admin/alertes?statut=${k}"><strong>${cnt[k] || 0}</strong><span>${STATUS_FR[k]} (24 h)</span></a>`).join('')}</div>
      <div class="chips" style="margin:10px 0"><a class="chip ${!st ? 'on' : ''}" href="/admin/alertes">Toutes</a>${Object.entries(STATUS_FR).filter(([k]) => k !== 'sending').map(([k, l]) => `<a class="chip ${st === k ? 'on' : ''}" href="/admin/alertes?statut=${k}">${l}</a>`).join('')}</div>
      <div class="mylist">${rows.map((a) => `<div class="logrow" id="alert-${a.id}"><div><span class="st ${cls[a.status]}">${STATUS_FR[a.status]}</span> ${a.channel ? CHANNELS[a.channel] : ''} → <strong>${esc(a.to_name || fmtPhone(a.u_phone))}</strong> <span class="muted small">${esc(fmtPhone(a.u_phone))}</span></div>
        <div class="small">De ${esc(a.from_name || '—')} · « ${esc(a.ad_title || '')} » · conv. n° ${a.conversation_id}</div>
        ${a.body ? `<div class="small" style="background:#f6f7f9;border-radius:8px;padding:6px 8px;margin:4px 0">${esc(a.body)}</div>` : ''}
        <div class="small muted">Créée ${fmtDate(a.created_at)}${a.sent_at ? ` · envoyée ${fmtDate(a.sent_at)}` : a.status === 'queued' ? ` · prévue ${fmtDate(a.due_at)}` : ''}${a.provider ? ` · ${esc(a.provider)}` : ''}${a.reason ? ` · ${esc(a.reason)}` : ''}</div></div>`).join('') || '<p class="muted">Aucune alerte pour le moment.</p>'}</div>`;
    return adminPage(req, 'alertes', 'Alertes envoyées', body);
  }
  const stats24 = () => Object.fromEntries(db.prepare('SELECT status k, COUNT(*) n FROM alerts WHERE created_at > ? GROUP BY status').all(Date.now() - DAY).map((r) => [r.k, r.n]));
  return { onMessage, tick, adminAlerts, stats24, CFG };
};
