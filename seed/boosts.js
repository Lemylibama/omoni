// Boosts + paiements d'EXEMPLE (recréés à chaque appel)
const crypto = require('crypto');
const DAY = 86400000;
const BOOSTS = [ // [n° d'annonce d'exemple, produit, jours restants, il y a (heures)]
  [1, 'une', 5, 50], [11, 'une', 6, 26], [4, 'une', 3, 100], [10, 'urgent', 4, 70], [4, 'urgent', 2, 120], [20, 'remonter', 0, 30],
];
module.exports = function seedBoosts(db) {
  db.exec('DELETE FROM transactions WHERE is_example = 1; UPDATE ads SET featured_until = NULL, urgent_until = NULL, bumped_at = NULL WHERE is_example = 1;');
  const ads = db.prepare('SELECT a.*, u.phone owner_phone FROM ads a LEFT JOIN users u ON u.id = a.user_id WHERE a.is_example = 1 ORDER BY a.id').all();
  const prods = Object.fromEntries(db.prepare('SELECT * FROM boost_products').all().map((p) => [p.code, p]));
  let n = 0;
  for (const [i, code, left, ago] of BOOSTS) {
    const ad = ads[i - 1]; const p = prods[code]; if (!ad || !p || !ad.owner_phone) continue;
    const at = Date.now() - ago * 3600000; const op = /^\+24206/.test(ad.owner_phone) ? 'mtn' : 'airtel';
    if (code === 'une') db.prepare('UPDATE ads SET featured_until = ? WHERE id = ?').run(Date.now() + left * DAY, ad.id);
    if (code === 'urgent') db.prepare('UPDATE ads SET urgent_until = ? WHERE id = ?').run(Date.now() + left * DAY, ad.id);
    if (code === 'remonter') db.prepare('UPDATE ads SET bumped_at = ? WHERE id = ?').run(at, ad.id);
    db.prepare(`INSERT INTO transactions (ref, user_id, ad_id, ad_title, product_code, product_name, duration_days, amount, provider, operator, payer_phone, status, provider_ref, boost_applied, is_example, created_at, updated_at, completed_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?, 'dev', ?, ?, 'success', ?, 1, 1, ?, ?, ?, ?)`).run(crypto.randomUUID(), ad.user_id, ad.id, ad.title, code, p.name, p.duration_days, p.price, op, ad.owner_phone, 'EXEMPLE-' + (n + 1), at, at, at + 40000, at + 600000);
    n++;
  }
  return n;
};
