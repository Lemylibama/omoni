// Alertes d'EXEMPLE (mode test) pour que la page Admin › Alertes envoyées ne soit pas vide sur le site d'essai.
// Recréées à chaque appel ; uniquement des alertes terminées (envoyées / non envoyées), jamais « en attente ».
const MIN = 60000;
module.exports = function seedAlerts(db) {
  db.exec('DELETE FROM alerts');
  const convs = db.prepare('SELECT * FROM conversations WHERE is_example = 1 ORDER BY id').all();
  const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const base = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const ins = db.prepare(`INSERT INTO alerts (user_id, conversation_id, sender_id, channel, provider, to_phone, body, link, status, reason, due_at, created_at, sent_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const plan = [[0, 'seller', 'sms', 'sent', 'Mode test : non envoyée réellement', 298], [1, 'buyer', 'whatsapp', 'sent', 'Mode test : non envoyée réellement', 868], [0, 'buyer', 'sms', 'skipped', 'Message déjà lu', 278]];
  let n = 0;
  for (const [ci, who, ch, status, reason, agoMin] of plan) {
    const c = convs[ci]; if (!c) continue;
    const to = user(who === 'seller' ? c.seller_id : c.buyer_id), from = user(who === 'seller' ? c.buyer_id : c.seller_id);
    const link = `${base}/messages/${c.id}`; const t = Date.now() - agoMin * MIN;
    const text = `OMONI : nouveau message de ${from.display_name} à propos de « ${c.ad_title.slice(0, 39)} ». Répondez : ${link}`;
    ins.run(to.id, c.id, from.id, ch, 'dev', to.phone, status === 'sent' ? (ch === 'sms' ? text.replace(/[«»]/g, '"') : text) : null, link, status, reason, t, t - 2 * MIN, status === 'sent' ? t : null);
    n++;
  }
  return n;
};
