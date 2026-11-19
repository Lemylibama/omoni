const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(__dirname, 'data', 'annonces.db'));
const DAY = 86400000;
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,            -- format international : +242061234567
  display_name TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  city TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  seller_name TEXT NOT NULL,
  phone TEXT NOT NULL,                   -- numéro de contact local (9 chiffres)
  status TEXT NOT NULL DEFAULT 'active', -- active | sold | hidden
  is_example INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  ip TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ad_id INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ad_id)
);
CREATE INDEX IF NOT EXISTS idx_ads_created ON ads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_photos_ad ON photos(ad_id);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone, created_at);
CREATE INDEX IF NOT EXISTS idx_otp_ip ON otp_codes(ip, created_at);
`);
// migrations légères pour les bases existantes
const cols = db.prepare('PRAGMA table_info(ads)').all().map((c) => c.name);
if (!cols.includes('user_id')) db.exec('ALTER TABLE ads ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
if (!cols.includes('expires_at')) db.exec('ALTER TABLE ads ADD COLUMN expires_at INTEGER');
if (!cols.includes('sold_at')) db.exec('ALTER TABLE ads ADD COLUMN sold_at INTEGER');
db.prepare('UPDATE ads SET expires_at = created_at + ? WHERE expires_at IS NULL').run(60 * DAY);
db.exec('CREATE INDEX IF NOT EXISTS idx_ads_user ON ads(user_id)');
const addCol = (table, col, def) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
// v3 : modération
addCol('users', 'role', "TEXT NOT NULL DEFAULT 'user'");      // user | admin
addCol('users', 'banned_at', 'INTEGER');
addCol('users', 'ban_reason', 'TEXT');
addCol('ads', 'moderation_note', 'TEXT');   // motif de masquage / refus, affiché au vendeur
addCol('ads', 'flagged_words', 'TEXT');     // mots interdits détectés
addCol('ads', 'renewed_at', 'INTEGER');
addCol('reports', 'status', "TEXT NOT NULL DEFAULT 'open'"); // open | dismissed | actioned
addCol('reports', 'resolved_at', 'INTEGER');
addCol('reports', 'resolved_by', 'INTEGER');
addCol('reports', 'resolution', 'TEXT');
addCol('reports', 'reporter_id', 'INTEGER');
db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER, admin_phone TEXT,
  action TEXT NOT NULL, target_type TEXT, target_id INTEGER, details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, ad_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
`);
// v4 : messagerie
db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id INTEGER REFERENCES ads(id) ON DELETE SET NULL,
  ad_title TEXT NOT NULL,                -- copie : la conversation reste lisible si l'annonce est supprimée
  buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  buyer_last_read INTEGER NOT NULL DEFAULT 0,  -- id du dernier message lu
  seller_last_read INTEGER NOT NULL DEFAULT 0,
  is_example INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  UNIQUE (ad_id, buyer_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  flagged_words TEXT,
  is_example INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS conversation_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- NULL = signalement automatique (mots interdits)
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open | dismissed | actioned
  resolved_at INTEGER, resolved_by INTEGER, resolution TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_buyer ON conversations(buyer_id, last_message_at);
CREATE INDEX IF NOT EXISTS idx_conv_seller ON conversations(seller_id, last_message_at);
CREATE INDEX IF NOT EXISTS idx_creports ON conversation_reports(status, conversation_id);
`);
db.unreadCount = (uid) => db.prepare(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id
  WHERE m.sender_id != ? AND ((c.buyer_id = ? AND m.id > c.buyer_last_read) OR (c.seller_id = ? AND m.id > c.seller_last_read))`).get(uid, uid, uid).n;
// v5 : boosts payants (Mobile Money)
addCol('ads', 'featured_until', 'INTEGER');
addCol('ads', 'urgent_until', 'INTEGER');
addCol('ads', 'bumped_at', 'INTEGER');
db.exec(`
CREATE TABLE IF NOT EXISTS boost_products (
  code TEXT PRIMARY KEY,           -- remonter | une | urgent
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL,          -- FCFA
  duration_days INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,        -- UUID v4 : X-Reference-Id MTN / transaction.id Airtel / clé d'idempotence
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ad_id INTEGER REFERENCES ads(id) ON DELETE SET NULL,
  ad_title TEXT,
  product_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  duration_days INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XAF',
  provider TEXT NOT NULL,          -- dev | mtn | airtel
  operator TEXT NOT NULL,          -- mtn | airtel
  payer_phone TEXT NOT NULL,       -- +242…
  status TEXT NOT NULL DEFAULT 'pending', -- pending | success | failed | expired | refunded
  provider_ref TEXT,               -- financialTransactionId / airtel_money_id
  failure_reason TEXT,
  boost_applied INTEGER NOT NULL DEFAULT 0,
  is_example INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  refunded_at INTEGER, refund_note TEXT, refunded_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status, expires_at);
CREATE TABLE IF NOT EXISTS payment_events (    -- trace brute des callbacks reçus (débogage / litiges)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT, provider TEXT, verified INTEGER, body TEXT, created_at INTEGER NOT NULL
);
`);
const DEFAULT_PRODUCTS = [
  ['remonter', 'Remonter en tête', "Votre annonce repasse en tête des annonces récentes, comme si elle venait d'être publiée.", 500, 0, 1],
  ['une', 'À la une', 'Badge « À la une », mise en avant en haut de l’accueil et des résultats pendant 7 jours.', 2000, 7, 2],
  ['urgent', 'Urgent', 'Badge rouge « Urgent » bien visible sur votre annonce pendant 7 jours.', 1000, 7, 3],
];
for (const p of DEFAULT_PRODUCTS) db.prepare('INSERT OR IGNORE INTO boost_products (code, name, description, price, duration_days, sort) VALUES (?,?,?,?,?,?)').run(...p);
const DEFAULT_SETTINGS = { premoderation: '0', banned_words: '', banned_words_action: 'pending' };
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
db.getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? DEFAULT_SETTINGS[k];
db.setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
module.exports = db;
// v6 : alertes SMS / WhatsApp pour les nouveaux messages
addCol('users', 'notify_channel', "TEXT NOT NULL DEFAULT 'sms'"); // sms | whatsapp | none
addCol('users', 'quiet_hours', 'INTEGER NOT NULL DEFAULT 1');      // pas d'alerte 22 h – 7 h (heure de Brazzaville)
db.exec(`
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- destinataire
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  channel TEXT,                    -- sms | whatsapp (au moment de l'envoi)
  provider TEXT,                   -- dev | twilio | meta | …
  to_phone TEXT,
  body TEXT,                       -- texte de l'alerte (jamais le contenu du message)
  link TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | sending | sent | failed | skipped
  reason TEXT,                     -- motif (report, non-envoi) ou erreur fournisseur
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_due ON alerts(status, due_at);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, status, sent_at);
CREATE INDEX IF NOT EXISTS idx_alerts_conv ON alerts(user_id, conversation_id, status);
`);
// v7 : quartier (facultatif) — voir quartiers.js
addCol('ads', 'quartier', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_ads_quartier ON ads(city, quartier)');
