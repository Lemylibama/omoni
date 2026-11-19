// Insère les annonces d'exemple rattachées à quelques comptes vendeurs de démo.
// Idempotent : ne fait rien si des exemples existent déjà, sauf avec --reset.
const fs = require('fs'); const path = require('path');
const db = require('../db');
const ads = require('./ads.json');
const UP = path.join(__dirname, '..', 'uploads');
const DAY = 86400000;
const TTL = (require('../config').AD_TTL_DAYS || 60) * DAY;
fs.mkdirSync(UP, { recursive: true });
const DEMO_USERS = [
  { phone: '+242061234567', name: 'Jean-Claude M.' },
  { phone: '+242055551234', name: 'Prince K.' },
  { phone: '+242066543210', name: 'Mireille N.' },
  { phone: '+242068765432', name: 'Maman Bijou' },
];
// Compte administrateur de démonstration (connexion par code comme les autres)
const DEMO_ADMIN = { phone: '+242060000001', name: 'Admin démo' };
const EXAMPLE_REPORTS = [ // signalements d'exemple pour que la file de modération ne soit pas vide
  { ad: 2, reason: 'Arnaque / fraude', details: "EXEMPLE — le vendeur demande un acompte par Mobile Money avant de montrer la moto." },
  { ad: 2, reason: 'Annonce en double', details: 'EXEMPLE — même annonce publiée deux fois.' },
  { ad: 20, reason: 'Mauvaise catégorie', details: 'EXEMPLE — devrait être dans « Agriculture & Élevage » > volailles.' },
];
if (process.argv.includes('--reset')) {
  db.exec('DELETE FROM ads WHERE is_example=1; DELETE FROM users WHERE is_demo=1;'); // cascade : photos, signalements, favoris, sessions
}
if (db.prepare('SELECT COUNT(*) n FROM ads WHERE is_example=1').get().n) { console.log('Exemples déjà présents.'); process.exit(0); }
const userIds = DEMO_USERS.map((u) => db.prepare('INSERT INTO users (phone, display_name, is_demo, created_at) VALUES (?,?,1,?) ON CONFLICT(phone) DO UPDATE SET is_demo=1 RETURNING id').get(u.phone, u.name, Date.now()).id);
db.prepare("INSERT INTO users (phone, display_name, role, is_demo, created_at) VALUES (?,?,'admin',1,?) ON CONFLICT(phone) DO UPDATE SET role='admin', is_demo=1").run(DEMO_ADMIN.phone, DEMO_ADMIN.name, Date.now());
const adIds = [];
const insAd = db.prepare('INSERT INTO ads (title, category, city, quartier, price, description, seller_name, phone, is_example, user_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)');
const insPh = db.prepare('INSERT INTO photos (ad_id, filename, position) VALUES (?,?,?)');
ads.forEach((a, i) => {
  const created = Date.now() - a.h * 3600000 - i * 60000;
  const id = insAd.run(a.title, a.category, a.city, a.quartier || null, a.price, a.desc, a.seller, a.phone, userIds[i % userIds.length], created, created + TTL).lastInsertRowid;
  adIds.push(id);
  a.img.forEach((_, j) => { const f = `ex${String(i + 1).padStart(2, '0')}-${j + 1}.jpg`; fs.copyFileSync(path.join(__dirname, 'images', f), path.join(UP, f)); insPh.run(id, f, j); });
});
EXAMPLE_REPORTS.forEach((r, i) => db.prepare("INSERT INTO reports (ad_id, reason, details, ip, created_at) VALUES (?,?,?,?,?)").run(adIds[r.ad - 1], r.reason, r.details, 'exemple-' + (i + 1), Date.now() - (i + 1) * 3600000));
console.log(`${require('./conversations')(db)} conversations d'exemple.`);
console.log(`${require('./boosts')(db)} boosts / paiements d'exemple.`);
console.log(`${require('./alerts')(db)} alertes d'exemple.`);
console.log(`Admin de démo : ${DEMO_ADMIN.phone} · ${EXAMPLE_REPORTS.length} signalements d'exemple.`);
console.log(`${ads.length} annonces d'exemple ajoutées, réparties sur ${userIds.length} comptes de démo.`);
