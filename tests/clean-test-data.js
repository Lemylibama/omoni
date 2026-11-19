// Supprime les données de test : comptes non-démo, annonces non-exemple, codes, sessions, favoris, signalements
// (sauf ceux d'exemple), messages, blocages, journal ; remet les réglages, les annonces d'exemple et les comptes de démo dans leur état initial.
const fs = require('fs'); const path = require('path'); const db = require('../db');
db.exec(`DELETE FROM ads WHERE is_example=0; DELETE FROM users WHERE is_demo=0; DELETE FROM otp_codes; DELETE FROM sessions; DELETE FROM favorites;
DELETE FROM reports WHERE ip NOT LIKE 'exemple-%'; UPDATE reports SET status='open', resolved_at=NULL, resolved_by=NULL, resolution=NULL;
DELETE FROM audit_log; UPDATE users SET banned_at=NULL, ban_reason=NULL WHERE is_demo=1;
UPDATE ads SET status='active', moderation_note=NULL, flagged_words=NULL WHERE is_example=1;`);
db.exec('DELETE FROM blocks; DELETE FROM conversation_reports; DELETE FROM conversations WHERE is_example = 0;');
require('../seed/conversations')(db);
db.exec("DELETE FROM transactions WHERE is_example = 0; DELETE FROM payment_events; UPDATE boost_products SET active = 1;");
for (const [c, price, d, name] of [['remonter', 500, 0, 'Remonter en tête'], ['une', 2000, 7, 'À la une'], ['urgent', 1000, 7, 'Urgent']]) db.prepare('UPDATE boost_products SET price = ?, duration_days = ?, name = ? WHERE code = ?').run(price, d, name, c);
require('../seed/boosts')(db); // boosts et paiements d'exemple remis à l'état initial // remet les conversations d'exemple dans leur état initial
db.setSetting('premoderation', '0'); db.setSetting('banned_words', ''); db.setSetting('banned_words_action', 'pending');
const UP = path.join(__dirname, '..', 'uploads');
const used = new Set(db.prepare('SELECT filename FROM photos').all().map((r) => r.filename));
let n = 0; for (const f of fs.readdirSync(UP)) if (!used.has(f)) { fs.unlinkSync(path.join(UP, f)); n++; }
console.log('Données de test nettoyées ; fichiers orphelins supprimés :', n);
