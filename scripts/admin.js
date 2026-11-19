#!/usr/bin/env node
// Gestion des administrateurs en ligne de commande
//   npm run admin -- promote 06 000 00 01   -> donne le rôle admin (crée le compte si besoin)
//   npm run admin -- demote  +242060000001  -> retire le rôle admin
//   npm run admin -- list                   -> liste les administrateurs
const db = require('../db');
const [cmd, ...rest] = process.argv.slice(2);
const raw = rest.join('');
const norm = (r) => { let p = String(r || '').replace(/[^\d+]/g, '').replace(/^(\+|00)242/, ''); return /^0[4-6]\d{7}$/.test(p) ? '+242' + p : null; };
const log = (action, phone, details) => db.prepare('INSERT INTO audit_log (admin_id, admin_phone, action, target_type, target_id, details, created_at) VALUES (NULL, ?, ?, ?, ?, ?, ?)')
  .run('système', action, 'utilisateur', db.prepare('SELECT id FROM users WHERE phone = ?').get(phone)?.id ?? null, details, Date.now());
if (cmd === 'list') {
  const rows = db.prepare("SELECT phone, display_name, banned_at FROM users WHERE role = 'admin' ORDER BY phone").all();
  console.log(rows.length ? rows.map((r) => `${r.phone}  ${r.display_name || ''}${r.banned_at ? ' (banni)' : ''}`).join('\n') : 'Aucun administrateur.');
} else if (cmd === 'promote' || cmd === 'demote') {
  const phone = norm(raw);
  if (!phone) { console.error('Numéro mobile congolais invalide (ex : 06 000 00 01).'); process.exit(1); }
  if (cmd === 'promote') {
    db.prepare("INSERT INTO users (phone, role, created_at) VALUES (?, 'admin', ?) ON CONFLICT(phone) DO UPDATE SET role = 'admin', banned_at = NULL, ban_reason = NULL").run(phone, Date.now());
    log('role_admin', phone, `${phone} promu administrateur (CLI)`); console.log(`✔ ${phone} est administrateur.`);
  } else {
    const n = db.prepare("UPDATE users SET role = 'user' WHERE phone = ?").run(phone).changes;
    if (n) log('role_admin', phone, `${phone} n'est plus administrateur (CLI)`); console.log(n ? `✔ ${phone} n'est plus administrateur.` : 'Compte introuvable.');
  }
} else { console.log('Usage : npm run admin -- promote|demote <téléphone> | list'); process.exit(cmd ? 1 : 0); }
