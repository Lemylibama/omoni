const express = require('express');
const { execFileSync } = require('child_process');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
// Disque éphémère (Render gratuit) : base vide au démarrage -> données d'exemple (annonces, comptes de démo dont l'admin, conversations, boosts)
if (process.env.AUTO_SEED !== '0' && !db.prepare('SELECT COUNT(*) n FROM ads').get().n) {
  console.log('Base vide : insertion des données d\'exemple…');
  execFileSync(process.execPath, [require('path').join(__dirname, 'seed', 'seed.js')], { stdio: 'inherit' });
}
const C = require('./config');
const auth = require('./auth');
const sms = require('./sms');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DAY = 86400000;
const AD_TTL_DAYS = C.AD_TTL_DAYS || 60;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.set('trust proxy', true);
app.disable('x-powered-by');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const catBySlug = Object.fromEntries(C.CATEGORIES.map((c) => [c.slug, c]));
const fmtPrice = (p) => (p > 0 ? new Intl.NumberFormat('fr-FR').format(p).replace(/\u202f|\u00a0/g, ' ') + ' FCFA' : 'Prix à discuter');
const TZ = 'Africa/Brazzaville';
function fmtDate(ts) {
  const d = new Date(ts);
  const day = (x) => x.toLocaleDateString('fr-FR', { timeZone: TZ });
  const time = d.toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  if (day(d) === day(now)) return `Aujourd'hui, ${time}`;
  if (day(d) === day(new Date(now - DAY))) return `Hier, ${time}`;
  return d.toLocaleDateString('fr-FR', { timeZone: TZ, day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
const fmtDay = (ts) => new Date(ts).toLocaleDateString('fr-FR', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
// Numéros congolais : 9 chiffres, 04/05/06 (mobile) ou 22 (fixe). On garde le 0 en international (+242 06...).
function normPhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  p = p.replace(/^(\+|00)242/, '');
  return /^(0[4-6]\d{7}|22\d{7})$/.test(p) ? p : null;
}
const fmtPhone = (p) => { p = String(p).replace(/^\+242/, ''); return `+242 ${p.slice(0, 2)} ${p.slice(2, 5)} ${p.slice(5, 7)} ${p.slice(7)}`; };
const maskPhone = (p) => { p = String(p).replace(/^\+242/, ''); return `+242 ${p.slice(0, 2)} *** ** ${p.slice(7)}`; };
const STATUS_FR = { active: 'En ligne', sold: 'Vendu', hidden: 'Masquée', pending: 'En attente', rejected: 'Refusée' };
const safeNext = (n) => (typeof n === 'string' && /^\/(?![\/\\])/.test(n) ? n : '/');
// annonces visibles publiquement : actives, non expirées, vendeur non banni
const LIVE = () => `status = 'active' AND expires_at > ${Date.now()} AND (user_id IS NULL OR user_id NOT IN (SELECT id FROM users WHERE banned_at IS NOT NULL))`;
const RENEW_COOLDOWN = 24 * 3600000;
// Filtre de mots interdits : comparaison sans accents ni majuscules, mots entiers
const norm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function bannedWordsIn(text) {
  const words = db.getSetting('banned_words').split(/[\n,]+/).map((w) => w.trim()).filter(Boolean);
  const hay = ' ' + norm(text).replace(/[^a-z0-9]+/g, ' ') + ' ';
  return words.filter((w) => { const n = norm(w).replace(/[^a-z0-9]+/g, ' ').trim(); return n && hay.includes(' ' + n + ' '); });
}
function audit(req, action, type, id, details) {
  db.prepare('INSERT INTO audit_log (admin_id, admin_phone, action, target_type, target_id, details, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(req?.user?.id ?? null, req?.user?.phone ?? 'système', action, type, id ?? null, details ? String(details).slice(0, 500) : null, Date.now());
}

const firstPhotoStmt = db.prepare('SELECT filename FROM photos WHERE ad_id = ? ORDER BY position LIMIT 1');
const photoUrl = (f) => (f ? `/uploads/${f}` : null);
const favSet = (req) => new Set(req.user ? db.prepare('SELECT ad_id FROM favorites WHERE user_id = ?').all(req.user.id).map((r) => r.ad_id) : []);
const csrfField = (req) => `<input type="hidden" name="_csrf" value="${req.csrfToken}">`;

function layout(req, { title, body, desc = C.TAGLINE, scripts = '' }) {
  const u = req.user;
  const unread = u ? db.unreadCount(u.id) : 0;
  const acct = u
    ? `<a class="msg-link" href="/messages" aria-label="Messages${unread ? ` (${unread} non lus)` : ''}">💬${unread ? `<span class="badge hb" id="hdr-unread">${unread}</span>` : ''}</a><details class="menu"><summary aria-label="Mon compte"><span class="avatar sm">${u.display_name ? esc(Array.from(u.display_name.trim())[0].toUpperCase()) : '👤'}</span><span class="hide-xs">Mon compte</span></summary>
      <div class="menu-pop"><div class="menu-h">${esc(u.display_name || 'Mon compte')}<br><span class="muted small">${esc(fmtPhone(u.phone))}</span></div>
      <a href="/messages">💬 Messages${unread ? ` <span class="badge">${unread}</span>` : ''}</a><a href="/mes-annonces">📋 Mes annonces</a><a href="/mes-favoris">♡ Mes favoris</a><a href="/mes-paiements">💳 Mes paiements</a>${u.role === 'admin' ? '<a href="/admin">🛡 Administration</a>' : ''}
      <form method="post" action="/deconnexion">${csrfField(req)}<button type="submit">↩ Déconnexion</button></form></div></details>`
    : `<a class="login-link" href="/connexion?next=${encodeURIComponent(req.originalUrl.startsWith('/connexion') ? '/' : req.originalUrl)}">Se connecter</a>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title ? title + ' · ' + C.BRAND : C.BRAND + ' — ' + C.TAGLINE)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#0a7d46">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🛒</text></svg>">
<link rel="stylesheet" href="/static/style.css?v=5">
</head><body>
<header class="top"><div class="wrap top-in">
  <a class="logo" href="/"><span class="logo-mark">${esc(C.BRAND[0])}</span>${esc(C.BRAND)}</a>
  <div class="top-r">${acct}<a class="btn btn-post" href="/deposer">+ <span class="hide-xs">Déposer une annonce</span><span class="show-xs">Déposer</span></a></div>
</div></header>
<main class="wrap">${body}</main>
<footer class="foot"><div class="wrap">
  <p><strong>${esc(C.BRAND)}</strong> — ${esc(C.TAGLINE)} · République du Congo</p>
  <p class="muted">Conseils : rencontrez le vendeur dans un lieu public, vérifiez l'article avant de payer, ne versez jamais d'avance par Mobile Money à un inconnu.</p>
  <p class="muted">Version de démonstration — les annonces marquées « Exemple » sont fictives.</p>
</div></footer>
<script src="/static/app.js?v=2" defer></script>${scripts}
</body></html>`;
}

function favButton(req, adId, isFav) {
  if (!req.user) return `<a class="fav" href="/connexion?next=${encodeURIComponent(req.originalUrl)}" aria-label="Ajouter aux favoris (connexion requise)" title="Se connecter pour ajouter aux favoris">♡</a>`;
  return `<form class="fav-f" method="post" action="/favoris/${adId}">${csrfField(req)}<input type="hidden" name="back" value="${esc(req.originalUrl)}">
  <button class="fav ${isFav ? 'on' : ''}" type="submit" aria-pressed="${isFav}" aria-label="${isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${isFav ? '♥' : '♡'}</button></form>`;
}

function card(req, favs) {
  return (ad) => {
    const img = photoUrl(firstPhotoStmt.get(ad.id)?.filename);
    const now = Date.now(); const une = ad.featured_until > now, urg = ad.urgent_until > now;
    return `<div class="cardw"><a class="card${une ? ' featured' : ''}" href="/annonce/${ad.id}">
  <div class="card-img">${img ? `<img src="${img}" alt="" loading="lazy" width="320" height="240">` : `<span class="noimg">${catBySlug[ad.category]?.icon || '📦'}</span>`}
  ${ad.is_example ? '<span class="tag-ex">Exemple</span>' : ''}${ad.status === 'sold' ? '<span class="tag-sold">Vendu</span>' : ''}
  ${une || urg ? `<span class="tags-b">${une ? '<span class="tag-une">⭐ À la une</span>' : ''}${urg ? '<span class="tag-urg">🔥 Urgent</span>' : ''}</span>` : ''}</div>
  <div class="card-body">
    <div class="card-title">${esc(ad.title)}</div>
    <div class="card-price">${fmtPrice(ad.price)}</div>
    <div class="card-meta">${esc(ad.city)} · ${fmtDate(ad.created_at)}</div>
  </div></a>${favButton(req, ad.id, favs.has(ad.id))}</div>`;
  };
}

function searchBar(v = {}) {
  return `<form class="search" action="/annonces" method="get" role="search">
  <input type="search" name="q" value="${esc(v.q || '')}" placeholder="Que recherchez-vous ?" aria-label="Rechercher">
  <select name="ville" aria-label="Ville"><option value="">Toutes les villes</option>${C.CITIES.map((c) => `<option ${v.ville === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
  <button class="btn" type="submit">Rechercher</button></form>`;
}
const page = (req, res, status, title, html) => res.status(status).send(layout(req, { title, body: `<div class="empty"><h1 class="h1">${esc(title)}</h1>${html}</div>` }));

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.get('accept')?.includes('application/json')) return res.status(401).json({ ok: false, login: '/connexion' });
  res.redirect(303, '/connexion?next=' + encodeURIComponent(req.method === 'GET' ? req.originalUrl : (req.get('referer') ? new URL(req.get('referer')).pathname : '/')));
}
function ownAd(req, res) {
  const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(Number(req.params.id) || 0);
  if (!ad) { page(req, res, 404, 'Annonce introuvable', '<a class="btn" href="/mes-annonces">Mes annonces</a>'); return null; }
  if (ad.user_id !== req.user.id) { page(req, res, 403, 'Action non autorisée', "<p>Cette annonce ne vous appartient pas.</p><a class=\"btn\" href=\"/mes-annonces\">Mes annonces</a>"); return null; }
  return ad;
}

// ---------- middlewares ----------
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' }); next(); });
const GATED = require('./gate')(app, express); // /healthz + mot de passe du site (SITE_PASSWORD)
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(auth.middleware);
app.use((req, res, next) => { if (req.user) res.set('Cache-Control', 'private, no-store'); next(); });

// ---------- home ----------
app.get('/', (req, res) => {
  const recent = db.prepare(`SELECT * FROM ads WHERE ${LIVE()} ORDER BY created_at DESC LIMIT 12`).all();
  // « À la une » : emplacements limités, tirage aléatoire à chaque affichage pour une rotation équitable
  const une = db.prepare(`SELECT * FROM ads WHERE ${LIVE()} AND featured_until > ? ORDER BY random() LIMIT ${C.FEATURED_SLOTS_HOME || 4}`).all(Date.now());
  const counts = Object.fromEntries(db.prepare(`SELECT category, COUNT(*) n FROM ads WHERE ${LIVE()} GROUP BY category`).all().map((r) => [r.category, r.n]));
  const body = `
  <section class="hero"><h1>Achetez et vendez près de chez vous</h1>
  <p>Petites annonces gratuites à Brazzaville, Pointe-Noire et partout au Congo.</p>${searchBar()}</section>
  ${une.length ? `<section class="une" id="une"><div class="row-h"><h2 class="h2">⭐ À la une</h2><a href="/annonces">Tout voir →</a></div><div class="grid">${une.map(card(req, favSet(req))).join('')}</div></section>` : ''}
  <h2 class="h2">Catégories</h2>
  <div class="cats">${C.CATEGORIES.map((c) => `<a class="cat" href="/annonces?cat=${c.slug}"><span class="cat-ic">${c.icon}</span><span class="cat-n">${esc(c.name)}</span><span class="cat-c">${counts[c.slug] || 0} annonce${(counts[c.slug] || 0) > 1 ? 's' : ''}</span></a>`).join('')}</div>
  <div class="row-h"><h2 class="h2">Annonces récentes</h2><a href="/annonces">Tout voir →</a></div>
  <div class="grid">${recent.map(card(req, favSet(req))).join('') || '<p class="muted">Aucune annonce pour le moment.</p>'}</div>
  <section class="cta"><h2>Vous avez quelque chose à vendre ?</h2><p>Publiez votre annonce gratuitement en 2 minutes.</p><a class="btn btn-post" href="/deposer">Déposer une annonce</a></section>`;
  res.send(layout(req, { title: '', body }));
});

// ---------- listing ----------
const SORTS = { recent: 'created_at DESC', ancien: 'created_at ASC', prix_asc: 'price ASC, created_at DESC', prix_desc: 'price DESC, created_at DESC' };
const PER_PAGE = 20;
app.get('/annonces', (req, res) => {
  const f = {
    q: String(req.query.q || '').trim().slice(0, 100),
    cat: catBySlug[req.query.cat] ? req.query.cat : '',
    ville: C.CITIES.includes(req.query.ville) ? req.query.ville : '',
    min: parseInt(req.query.min, 10) >= 0 ? parseInt(req.query.min, 10) : '',
    max: parseInt(req.query.max, 10) >= 0 ? parseInt(req.query.max, 10) : '',
    tri: SORTS[req.query.tri] ? req.query.tri : 'recent',
  };
  const pg = Math.max(1, parseInt(req.query.page, 10) || 1);
  const where = [LIVE()]; const params = [];
  if (f.q) { for (const w of f.q.split(/\s+/).slice(0, 6)) { where.push('(title LIKE ? OR description LIKE ?)'); params.push(`%${w}%`, `%${w}%`); } }
  if (f.cat) { where.push('category = ?'); params.push(f.cat); }
  if (f.ville) { where.push('city = ?'); params.push(f.ville); }
  if (f.min !== '') { where.push('price >= ?'); params.push(f.min); }
  if (f.max !== '') { where.push('price <= ?'); params.push(f.max); }
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) n FROM ads WHERE ${w}`).get(...params).n;
  const ads = db.prepare(`SELECT * FROM ads WHERE ${w} ORDER BY ${SORTS[f.tri]} LIMIT ${PER_PAGE} OFFSET ${(pg - 1) * PER_PAGE}`).all(...params);
  const pages = Math.ceil(total / PER_PAGE);
  const pinned = pg === 1 && f.tri === 'recent' ? db.prepare(`SELECT * FROM ads WHERE ${w} AND featured_until > ? ORDER BY random() LIMIT ${C.FEATURED_SLOTS_LIST || 3}`).all(...params, Date.now()) : [];
  const qs = (over) => '/annonces?' + new URLSearchParams(Object.entries({ ...f, ...over }).filter(([, v]) => v !== '' && v != null)).toString();
  const heading = f.cat ? catBySlug[f.cat].name : 'Toutes les annonces';
  const active = !!(f.q || f.cat || f.ville || f.min !== '' || f.max !== '');
  const body = `
  <h1 class="h1">${esc(heading)}${f.ville ? ' à ' + esc(f.ville) : ''}</h1>
  <details class="filters"><summary>Filtres & tri ${active ? '<span class="dot"></span>' : ''}</summary>
  <form method="get" action="/annonces" class="fform">
    <label>Mot-clé<input type="search" name="q" value="${esc(f.q)}" placeholder="ex : Toyota, iPhone, parcelle…"></label>
    <label>Catégorie<select name="cat"><option value="">Toutes</option>${C.CATEGORIES.map((c) => `<option value="${c.slug}" ${f.cat === c.slug ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <label>Ville<select name="ville"><option value="">Toutes</option>${C.CITIES.map((c) => `<option ${f.ville === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    <div class="two"><label>Prix min (FCFA)<input type="number" inputmode="numeric" min="0" step="500" name="min" value="${f.min}"></label>
    <label>Prix max (FCFA)<input type="number" inputmode="numeric" min="0" step="500" name="max" value="${f.max}"></label></div>
    <label>Trier par<select name="tri">
      <option value="recent" ${f.tri === 'recent' ? 'selected' : ''}>Plus récentes</option>
      <option value="ancien" ${f.tri === 'ancien' ? 'selected' : ''}>Plus anciennes</option>
      <option value="prix_asc" ${f.tri === 'prix_asc' ? 'selected' : ''}>Prix croissant</option>
      <option value="prix_desc" ${f.tri === 'prix_desc' ? 'selected' : ''}>Prix décroissant</option></select></label>
    <div class="two"><button class="btn" type="submit">Appliquer</button><a class="btn btn-ghost" href="/annonces">Réinitialiser</a></div>
  </form></details>
  <div class="chips">${C.CATEGORIES.map((c) => `<a class="chip ${f.cat === c.slug ? 'on' : ''}" href="${qs({ cat: f.cat === c.slug ? '' : c.slug, page: '' })}">${c.icon} ${esc(c.name)}</a>`).join('')}</div>
  <div class="row-h"><p class="muted">${total} annonce${total > 1 ? 's' : ''}</p>
  <form method="get" action="/annonces" class="sortf">${Object.entries(f).filter(([k, v]) => k !== 'tri' && v !== '').map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('')}
  <select name="tri" onchange="this.form.submit()" aria-label="Trier">
    <option value="recent" ${f.tri === 'recent' ? 'selected' : ''}>Plus récentes</option><option value="prix_asc" ${f.tri === 'prix_asc' ? 'selected' : ''}>Prix ↑</option><option value="prix_desc" ${f.tri === 'prix_desc' ? 'selected' : ''}>Prix ↓</option><option value="ancien" ${f.tri === 'ancien' ? 'selected' : ''}>Plus anciennes</option></select><noscript><button>OK</button></noscript></form></div>
  ${pinned.length ? `<section class="une pinned" id="une"><h2 class="h2 small-h">⭐ À la une</h2><div class="grid">${pinned.map(card(req, favSet(req))).join('')}</div></section>` : ''}
  <div class="grid">${ads.map(card(req, favSet(req))).join('') || '<div class="empty">Aucune annonce ne correspond à votre recherche.<br><a href="/annonces">Voir toutes les annonces</a></div>'}</div>
  ${pages > 1 ? `<nav class="pager">${pg > 1 ? `<a class="btn btn-ghost" href="${qs({ page: pg - 1 })}">← Précédent</a>` : '<span></span>'}<span>Page ${pg} / ${pages}</span>${pg < pages ? `<a class="btn btn-ghost" href="${qs({ page: pg + 1 })}">Suivant →</a>` : '<span></span>'}</nav>` : ''}`;
  res.send(layout(req, { title: heading, body }));
});

// ---------- detail ----------
const REASONS = ['Arnaque / fraude', 'Article interdit', 'Contenu choquant', 'Mauvaise catégorie', 'Annonce en double', 'Déjà vendu', 'Autre'];
app.get('/annonce/:id', (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(Number(req.params.id) || 0);
  const isOwner = ad && req.user && ad.user_id === req.user.id;
  const isAdmin = req.user?.role === 'admin';
  const expired = ad && ad.expires_at <= Date.now();
  const sellerBanned = ad && ad.user_id && db.prepare('SELECT banned_at FROM users WHERE id = ?').get(ad.user_id)?.banned_at;
  if (!ad || (!isOwner && !isAdmin && (!['active', 'sold'].includes(ad.status) || expired || sellerBanned))) return page(req, res, 404, ad && expired ? 'Cette annonce a expiré' : 'Annonce introuvable', '<p>Elle a peut-être été retirée.</p><a class="btn" href="/annonces">Voir les annonces</a>');
  const photos = db.prepare('SELECT filename FROM photos WHERE ad_id = ? ORDER BY position').all(ad.id);
  const cat = catBySlug[ad.category];
  const msg = `Bonjour ${ad.seller_name}, je suis intéressé(e) par votre annonce « ${ad.title} » (${fmtPrice(ad.price)}) vue sur ${C.BRAND}. Est-elle toujours disponible ?`;
  const wa = `https://wa.me/242${ad.phone}?text=${encodeURIComponent(msg)}`;
  const notices = [];
  if (req.query.nouveau) notices.push(ad.status === 'pending' ? '<div class="notice info">⏳ Annonce enregistrée : elle sera visible après validation par notre équipe.</div>' : ad.status === 'rejected' ? `<div class="notice bad">Votre annonce a été refusée : ${esc(ad.moderation_note || '')}</div>` : '<div class="notice ok">✅ Votre annonce est en ligne !</div>');
  if (isAdmin) notices.push(`<div class="notice test">🛡 Vue administrateur — statut : <strong>${esc(STATUS_FR[ad.status] || ad.status)}</strong>${expired ? ' (expirée)' : ''}${sellerBanned ? ' · vendeur banni' : ''}${ad.flagged_words ? ' · mots détectés : ' + esc(ad.flagged_words) : ''}${ad.moderation_note ? ' · note : ' + esc(ad.moderation_note) : ''} · <a href="/admin/annonces?id=${ad.id}">Gérer</a>${ad.user_id ? ` · <a href="/admin/utilisateurs/${ad.user_id}">Vendeur</a>` : ''}</div>`);
  if (req.query.modifie) notices.push('<div class="notice ok">✅ Annonce mise à jour.</div>');
  if (req.query.signale) notices.push('<div class="notice ok">Merci, votre signalement a été enregistré. Notre équipe va vérifier cette annonce.</div>');
  if (isOwner) notices.push(`<div class="notice info">C'est votre annonce${ad.status === 'hidden' ? ' — <strong>masquée</strong> par la modération' : ad.status === 'pending' ? ' — <strong>en attente de validation</strong>' : ad.status === 'rejected' ? ' — <strong>refusée</strong>' : expired ? ' — <strong>expirée</strong>' : ad.status === 'sold' ? ' — marquée <strong>vendue</strong>' : ` — en ligne jusqu'au ${fmtDay(ad.expires_at)}`}. <a href="/annonce/${ad.id}/modifier">Modifier</a>${ad.status === 'active' && !expired ? ` · <a href="/annonce/${ad.id}/booster"><strong>🚀 Booster</strong></a>` : ''} · <a href="/mes-annonces">Mes annonces</a></div>`);
  const similar = db.prepare(`SELECT * FROM ads WHERE ${LIVE()} AND category = ? AND id != ? ORDER BY created_at DESC LIMIT 4`).all(ad.category, ad.id);
  const favs = favSet(req);
  const body = `${notices.join('')}
  <nav class="crumbs"><a href="/">Accueil</a> › <a href="/annonces?cat=${ad.category}">${esc(cat?.name)}</a> › <a href="/annonces?cat=${ad.category}&ville=${encodeURIComponent(ad.city)}">${esc(ad.city)}</a></nav>
  <div class="detail">
  <div class="gallery">${photos.length ? `<div class="slides">${photos.map((p, i) => `<img src="${photoUrl(p.filename)}" alt="Photo ${i + 1} — ${esc(ad.title)}" ${i ? 'loading="lazy"' : ''}>`).join('')}</div>${photos.length > 1 ? `<div class="gcount">${photos.length} photos — faites glisser →</div>` : ''}` : `<div class="noimg big">${cat?.icon || '📦'}</div>`}</div>
  <div class="info">
    ${ad.is_example ? '<span class="tag-ex static">Annonce exemple (fictive)</span>' : ''}${ad.status === 'sold' ? ' <span class="tag-sold static">Vendu</span>' : ''}${ad.featured_until > Date.now() ? ' <span class="tag-une static">⭐ À la une</span>' : ''}${ad.urgent_until > Date.now() ? ' <span class="tag-urg static">🔥 Urgent</span>' : ''}
    <div class="title-row"><h1 class="h1">${esc(ad.title)}</h1>${favButton(req, ad.id, favs.has(ad.id))}</div>
    <div class="price">${fmtPrice(ad.price)}</div>
    <ul class="facts"><li>📍 ${esc(ad.city)}</li><li>${cat?.icon} ${esc(cat?.name)}</li><li>🕒 Publiée : ${fmtDate(ad.created_at)}</li></ul>
    <div class="seller"><span class="avatar">${esc(Array.from(ad.seller_name.trim())[0]?.toUpperCase() || '?')}</span><div><strong>${esc(ad.seller_name)}</strong><div class="muted">Particulier · ${esc(fmtPhone(ad.phone))}</div></div></div>
    ${ad.status === 'sold' ? '<p class="notice info">Cet article a été vendu.</p>' : `<div class="contact"><a class="btn btn-call" href="tel:+242${ad.phone}">📞 Appeler</a><a class="btn btn-wa" href="${wa}" target="_blank" rel="noopener">💬 WhatsApp</a>${!isOwner && ad.status === 'active' && !expired && !sellerBanned && ad.user_id ? `<a class="btn btn-msg" href="/annonce/${ad.id}/contacter">✉️ Envoyer un message</a>` : ''}</div>`}
    <h2 class="h2">Description</h2><div class="desc">${esc(ad.description).replace(/\n/g, '<br>')}</div>
    <p class="safety">🔒 Ne payez jamais d'avance (Mobile Money, transfert) avant d'avoir vu l'article. Rencontrez le vendeur dans un lieu public.</p>
    ${isOwner ? '' : `<details class="report"><summary>🚩 Signaler cette annonce</summary>
      <form method="post" action="/annonce/${ad.id}/signaler">${csrfField(req)}
        <label>Motif<select name="reason" required>${REASONS.map((r) => `<option>${r}</option>`).join('')}</select></label>
        <label>Précisions (facultatif)<textarea name="details" maxlength="500" rows="3"></textarea></label>
        <button class="btn btn-danger" type="submit">Envoyer le signalement</button></form></details>`}
    <p class="muted small">Annonce n° ${ad.id}</p>
  </div></div>
  ${similar.length ? `<h2 class="h2">Annonces similaires</h2><div class="grid">${similar.map(card(req, favs)).join('')}</div>` : ''}`;
  res.send(layout(req, { title: ad.title, body, desc: ad.description.slice(0, 150) }));
});

app.post('/annonce/:id/signaler', auth.csrfGuard, (req, res) => {
  const ad = db.prepare('SELECT id FROM ads WHERE id = ?').get(Number(req.params.id) || 0);
  if (!ad) return res.redirect('/annonces');
  const reason = REASONS.includes(req.body.reason) ? req.body.reason : 'Autre';
  db.prepare('INSERT INTO reports (ad_id, reason, details, ip, reporter_id, created_at) VALUES (?,?,?,?,?,?)').run(ad.id, reason, String(req.body.details || '').slice(0, 500), req.ip, req.user?.id ?? null, Date.now());
  const n = db.prepare("SELECT COUNT(DISTINCT ip) n FROM reports WHERE ad_id = ? AND status = 'open'").get(ad.id).n;
  if (n >= C.REPORT_HIDE_THRESHOLD && db.prepare("UPDATE ads SET status='hidden', moderation_note = ? WHERE id = ? AND status IN ('active','sold')").run('Masquée automatiquement suite à plusieurs signalements', ad.id).changes) {
    audit(null, 'auto_masquage', 'annonce', ad.id, `${n} signalements`); return res.redirect(303, '/annonces');
  }
  res.redirect(303, `/annonce/${ad.id}?signale=1`);
});

// ---------- connexion par SMS ----------
const testBanner = () => (sms.isDev ? '<div class="notice test">🧪 <strong>Mode test</strong> — aucun SMS n\'est réellement envoyé. Le code s\'affichera à l\'écran à l\'étape suivante.</div>' : '');
const readOtpCookie = (req) => { try { return JSON.parse(Buffer.from(auth.unsign(req.cookies.otp) || '', 'base64url').toString() || 'null'); } catch { return null; } };
const writeOtpCookie = (req, res, o) => auth.setCookie(req, res, 'otp', auth.sign(Buffer.from(JSON.stringify(o)).toString('base64url')), 15 * 60000);

function phoneStep(req, { phone = '', next = '/', error = '' } = {}) {
  return layout(req, { title: 'Connexion', body: `<div class="auth">
  <h1 class="h1">Se connecter</h1><p class="muted">Connectez-vous avec votre numéro de téléphone : nous vous envoyons un code par SMS. Pas de mot de passe à retenir.</p>
  ${testBanner()}${error ? `<div class="notice bad">${esc(error)}</div>` : ''}
  <form class="pform" method="post" action="/connexion">${csrfField(req)}<input type="hidden" name="next" value="${esc(next)}">
    <label>Numéro de téléphone<div class="phone"><span>+242</span><input name="phone" type="tel" inputmode="tel" autocomplete="tel" required value="${esc(phone)}" placeholder="06 123 45 67" autofocus></div></label>
    <p class="muted small">Numéro mobile MTN (06) ou Airtel (05, 04). Un compte est créé automatiquement à la première connexion.</p>
    <button class="btn big" type="submit">Recevoir mon code</button>
  </form></div>` });
}
app.get('/connexion', (req, res) => {
  const next = safeNext(req.query.next);
  if (req.user) return res.redirect(next);
  res.send(phoneStep(req, { next }));
});
app.post('/connexion', auth.csrfGuard, async (req, res) => {
  const next = safeNext(req.body.next);
  const local = normPhone(req.body.phone);
  if (local && local.startsWith('22')) return res.status(400).send(phoneStep(req, { phone: req.body.phone, next, error: 'Les numéros fixes (22) ne reçoivent pas les SMS. Utilisez un numéro mobile MTN ou Airtel.' }));
  if (!local) return res.status(400).send(phoneStep(req, { phone: req.body.phone, next, error: 'Numéro invalide. Format attendu : 06 123 45 67 (9 chiffres, commençant par 04, 05, 06 ou 22).' }));
  const phone = '+242' + local;
  const banned = db.prepare('SELECT banned_at, ban_reason FROM users WHERE phone = ? AND banned_at IS NOT NULL').get(phone);
  if (banned) return res.status(403).send(phoneStep(req, { phone: req.body.phone, next, error: `Ce compte est suspendu${banned.ban_reason ? ' (motif : ' + banned.ban_reason + ')' : ''}. Contactez-nous si vous pensez qu'il s'agit d'une erreur.` }));
  const r = await auth.sendCode(phone, req.ip, C.BRAND);
  if (!r.ok) return res.status(429).send(phoneStep(req, { phone: req.body.phone, next, error: r.error }));
  writeOtpCookie(req, res, { phone, next, dev: r.devCode });
  res.redirect(303, '/connexion/code');
});
function codeStep(req, o, error = '', expired = false) {
  return layout(req, { title: 'Code de connexion', body: `<div class="auth">
  <h1 class="h1">Entrez le code reçu</h1><p class="muted">Nous avons envoyé un code à 6 chiffres au <strong>${esc(maskPhone(o.phone))}</strong>. Il est valable 10 minutes.</p>
  ${sms.isDev ? `<div class="notice test">🧪 <strong>Mode test</strong> — aucun SMS envoyé. Votre code : <strong class="devcode">${esc(o.dev || '—')}</strong></div>` : ''}
  ${error ? `<div class="notice bad">${esc(error)}</div>` : ''}
  ${expired ? '' : `<form class="pform" method="post" action="/connexion/code">${csrfField(req)}
    <label>Code à 6 chiffres<input class="otp" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus placeholder="••••••"></label>
    <button class="btn big" type="submit">Valider</button></form>`}
  <form method="post" action="/connexion" class="inline-f">${csrfField(req)}<input type="hidden" name="phone" value="${esc(o.phone)}"><input type="hidden" name="next" value="${esc(o.next)}">
    <button class="linkbtn" type="submit">Renvoyer un code</button> · <a href="/connexion?next=${encodeURIComponent(o.next)}">Changer de numéro</a></form>
  </div>` });
}
app.get('/connexion/code', (req, res) => {
  const o = readOtpCookie(req);
  if (!o) return res.redirect('/connexion');
  res.send(codeStep(req, o));
});
app.post('/connexion/code', auth.csrfGuard, (req, res) => {
  const o = readOtpCookie(req);
  if (!o) return res.redirect(303, '/connexion');
  const r = auth.verifyCode(o.phone, String(req.body.code || '').replace(/\s/g, ''));
  if (!r.ok) return res.status(400).send(codeStep(req, o, r.error, r.expired));
  if (db.prepare('SELECT banned_at FROM users WHERE id = ?').get(r.userId)?.banned_at) return res.status(403).send(codeStep(req, o, 'Ce compte est suspendu.', true));
  auth.setCookie(req, res, 'otp', '', 0);
  auth.login(req, res, r.userId);
  res.redirect(303, r.isNew && o.next === '/' ? '/mes-annonces?bienvenue=1' : o.next);
});
app.post('/deconnexion', auth.csrfGuard, (req, res) => { auth.logout(req, res); res.redirect(303, '/'); });

// ---------- compte ----------
app.post('/compte', requireUser, auth.csrfGuard, (req, res) => {
  const name = String(req.body.display_name || '').trim().slice(0, 50);
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name || null, req.user.id);
  res.redirect(303, '/mes-annonces?profil=1');
});

app.get('/mes-annonces', requireUser, (req, res) => {
  const ads = db.prepare('SELECT * FROM ads WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  const now = Date.now();
  const row = (ad) => {
    const img = photoUrl(firstPhotoStmt.get(ad.id)?.filename);
    const expired = ad.expires_at <= now; const days = Math.ceil((ad.expires_at - now) / DAY);
    const st = ad.status === 'hidden' ? '<span class="st st-bad">Masquée</span>'
      : ad.status === 'pending' ? '<span class="st st-wait">En attente de validation</span>'
      : ad.status === 'rejected' ? '<span class="st st-bad">Refusée</span>'
      : ad.status === 'sold' ? '<span class="st st-sold">Vendu</span>'
      : expired ? '<span class="st st-bad">Expirée</span>' : '<span class="st st-ok">En ligne</span>';
    const exp = ad.status === 'hidden' ? `${esc(ad.moderation_note || 'Masquée par la modération.')} Contactez-nous si vous pensez que c'est une erreur.`
      : ad.status === 'pending' ? 'Notre équipe va vérifier votre annonce avant publication.'
      : ad.status === 'rejected' ? `Motif du refus : ${esc(ad.moderation_note || '—')}. Modifiez l'annonce pour la soumettre à nouveau.`
      : expired ? `A expiré le ${fmtDay(ad.expires_at)} — renouvelez-la pour la remettre en ligne.`
      : `Expire le ${fmtDay(ad.expires_at)} (dans ${days} jour${days > 1 ? 's' : ''})`;
    const f = (action, label, cls = 'btn-ghost') => `<form method="post" action="/annonce/${ad.id}/${action}">${csrfField(req)}<button class="btn sm ${cls}" type="submit">${label}</button></form>`;
    return `<div class="myad" id="ad-${ad.id}"><a class="myad-img" href="/annonce/${ad.id}">${img ? `<img src="${img}" alt="" loading="lazy">` : `<span class="noimg">${catBySlug[ad.category]?.icon}</span>`}</a>
    <div class="myad-b"><a class="myad-t" href="/annonce/${ad.id}">${esc(ad.title)}</a><div class="card-price">${fmtPrice(ad.price)}</div>
    <div class="small">${st} <span class="muted">${esc(ad.city)} · publiée ${fmtDate(ad.created_at).toLowerCase()}</span></div><div class="small muted">${exp}</div></div>
    ${ad.featured_until > now || ad.urgent_until > now ? `<div class="small myboost">${ad.featured_until > now ? `<span class="tag-une static">⭐ À la une</span> jusqu'au ${fmtDay(ad.featured_until)} ` : ''}${ad.urgent_until > now ? `<span class="tag-urg static">🔥 Urgent</span> jusqu'au ${fmtDay(ad.urgent_until)}` : ''}</div>` : ''}
    <div class="myad-a">${ad.status === 'active' && !expired ? `<a class="btn sm btn-boost" href="/annonce/${ad.id}/booster">🚀 Booster</a>` : ''}<a class="btn sm btn-ghost" href="/annonce/${ad.id}/modifier">✏️ Modifier</a>
    ${ad.status !== 'active' ? '' : (!expired && now - ad.created_at < RENEW_COOLDOWN) ? `<span class="btn sm btn-ghost disabled" title="Un renouvellement par 24 h">🔄 Renouvelable dans ${Math.ceil((RENEW_COOLDOWN - (now - ad.created_at)) / 3600000)} h</span>` : f('renouveler', '🔄 Renouveler')}
    ${ad.status === 'active' ? f('vendu', '✅ Marquer vendu') : ad.status === 'sold' ? f('vendu', '↩ Remettre en vente') : ''}
    <a class="btn sm btn-ghost danger" href="/annonce/${ad.id}/supprimer">🗑 Supprimer</a></div></div>`;
  };
  const q = req.query; const notice = q.bienvenue ? 'Bienvenue sur ' + C.BRAND + ' ! Votre compte est créé.' : q.profil ? 'Profil mis à jour.' : q.renouvele ? 'Annonce renouvelée : elle remonte en tête de liste.' : q.attente ? 'Vous ne pouvez renouveler une annonce qu\'une fois toutes les 24 heures.' : q.supprime ? 'Annonce supprimée.' : q.vendu ? 'Statut mis à jour.' : '';
  const body = `${notice ? `<div class="notice ok">${esc(notice)}</div>` : ''}
  <h1 class="h1">Mes annonces</h1>
  <details class="filters profile"><summary>👤 Mon profil — ${esc(req.user.display_name || 'ajouter un nom')} · ${esc(fmtPhone(req.user.phone))}</summary>
    <form method="post" action="/compte" class="fform">${csrfField(req)}<label>Nom affiché (facultatif)<input name="display_name" maxlength="50" value="${esc(req.user.display_name || '')}" placeholder="ex : Jean-Claude M."></label>
    <button class="btn" type="submit">Enregistrer</button></form></details>
  <p class="muted small">Les annonces restent en ligne ${AD_TTL_DAYS} jours. Renouvelez-les pour les remonter en tête de liste.</p>
  ${ads.length ? `<div class="mylist">${ads.map(row).join('')}</div>` : '<div class="empty">Vous n\'avez pas encore d\'annonce.<br><br><a class="btn btn-post" href="/deposer">Déposer une annonce</a></div>'}`;
  res.send(layout(req, { title: 'Mes annonces', body }));
});

app.get('/mes-favoris', requireUser, (req, res) => {
  const ads = db.prepare(`SELECT a.* FROM favorites f JOIN ads a ON a.id = f.ad_id WHERE f.user_id = ? AND a.status IN ('active','sold') AND a.expires_at > ? ORDER BY f.created_at DESC`).all(req.user.id, Date.now());
  const body = `<h1 class="h1">Mes favoris</h1>
  <div class="grid">${ads.map(card(req, favSet(req))).join('') || '<div class="empty">Aucun favori pour le moment. Touchez ♡ sur une annonce pour la retrouver ici.<br><br><a class="btn" href="/annonces">Parcourir les annonces</a></div>'}</div>`;
  res.send(layout(req, { title: 'Mes favoris', body }));
});

app.post('/favoris/:id', requireUser, auth.csrfGuard, (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!db.prepare('SELECT 1 FROM ads WHERE id = ?').get(id)) return res.status(404).json({ ok: false });
  const exists = db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND ad_id = ?').get(req.user.id, id);
  if (exists) db.prepare('DELETE FROM favorites WHERE user_id = ? AND ad_id = ?').run(req.user.id, id);
  else db.prepare('INSERT INTO favorites (user_id, ad_id, created_at) VALUES (?,?,?)').run(req.user.id, id, Date.now());
  if (req.get('accept')?.includes('application/json')) return res.json({ ok: true, fav: !exists });
  res.redirect(303, safeNext(req.body.back));
});

// ---------- actions propriétaire ----------
app.post('/annonce/:id/renouveler', requireUser, auth.csrfGuard, (req, res) => {
  const ad = ownAd(req, res); if (!ad) return;
  const now = Date.now();
  if (ad.status === 'active' && ad.expires_at > now && now - ad.created_at < RENEW_COOLDOWN) return res.redirect(303, '/mes-annonces?attente=1#ad-' + ad.id);
  if (ad.status === 'active') db.prepare('UPDATE ads SET created_at = ?, expires_at = ?, renewed_at = ? WHERE id = ?').run(now, now + AD_TTL_DAYS * DAY, now, ad.id);
  res.redirect(303, '/mes-annonces?renouvele=1#ad-' + ad.id);
});
app.post('/annonce/:id/vendu', requireUser, auth.csrfGuard, (req, res) => {
  const ad = ownAd(req, res); if (!ad) return;
  if (ad.status === 'active') db.prepare("UPDATE ads SET status = 'sold', sold_at = ? WHERE id = ?").run(Date.now(), ad.id);
  else if (ad.status === 'sold') db.prepare("UPDATE ads SET status = 'active', sold_at = NULL WHERE id = ?").run(ad.id);
  res.redirect(303, '/mes-annonces?vendu=1#ad-' + ad.id);
});
app.get('/annonce/:id/supprimer', requireUser, (req, res) => {
  const ad = ownAd(req, res); if (!ad) return;
  res.send(layout(req, { title: 'Supprimer l\'annonce', body: `<div class="auth"><h1 class="h1">Supprimer cette annonce ?</h1>
  <p>« <strong>${esc(ad.title)}</strong> » sera définitivement supprimée, avec ses photos. Cette action est irréversible.</p>
  <form class="two" method="post" action="/annonce/${ad.id}/supprimer">${csrfField(req)}<a class="btn btn-ghost" href="/mes-annonces">Annuler</a><button class="btn btn-danger" type="submit">Oui, supprimer</button></form></div>` }));
});
const deletePhotoFiles = (rows) => rows.forEach((p) => fs.unlink(path.join(UPLOAD_DIR, path.basename(p.filename)), () => {}));
app.post('/annonce/:id/supprimer', requireUser, auth.csrfGuard, (req, res) => {
  const ad = ownAd(req, res); if (!ad) return;
  const photos = db.prepare('SELECT filename FROM photos WHERE ad_id = ?').all(ad.id);
  db.prepare('DELETE FROM ads WHERE id = ?').run(ad.id);
  if (!ad.is_example) deletePhotoFiles(photos);
  res.redirect(303, '/mes-annonces?supprime=1');
});

// ---------- dépôt / modification ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' })[file.mimetype] || '.jpg'}`),
  }),
  limits: { fileSize: 6 * 1024 * 1024, files: C.MAX_PHOTOS, fields: 40 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});

function formPage(req, v = {}, errors = {}, { ad = null, photos = [] } = {}) {
  const err = (k) => (errors[k] ? `<span class="err">${esc(errors[k])}</span>` : '');
  const action = ad ? `/annonce/${ad.id}/modifier` : '/deposer';
  const body = `<h1 class="h1">${ad ? 'Modifier mon annonce' : 'Déposer une annonce'}</h1><p class="muted">${ad ? 'Les modifications sont visibles immédiatement.' : 'Gratuit · Votre annonce est visible immédiatement, pendant ' + AD_TTL_DAYS + ' jours.'}</p>
  ${Object.keys(errors).length ? `<div class="notice bad">Merci de corriger les champs indiqués ci-dessous.</div>` : ''}
  <form id="postf" class="pform" method="post" action="${action}" enctype="multipart/form-data" novalidate data-existing="${photos.length}" data-max="${C.MAX_PHOTOS}">${csrfField(req)}
    <label>Titre de l'annonce *<input name="title" maxlength="80" required value="${esc(v.title)}" placeholder="ex : Toyota Corolla 2012 climatisée">${err('title')}</label>
    <div class="two"><label>Catégorie *<select name="category" required><option value="">Choisir…</option>${C.CATEGORIES.map((c) => `<option value="${c.slug}" ${v.category === c.slug ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>${err('category')}</label>
    <label>Ville *<select name="city" required><option value="">Choisir…</option>${C.CITIES.map((c) => `<option ${v.city === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>${err('city')}</label></div>
    <label>Prix (FCFA) *<input name="price" type="number" inputmode="numeric" min="0" max="10000000000" step="1" required value="${esc(v.price)}" placeholder="ex : 250000 (0 = à discuter)">${err('price')}</label>
    <label>Description *<textarea name="description" rows="6" maxlength="4000" required placeholder="État, caractéristiques, quartier, conditions de vente…">${esc(v.description)}</textarea>${err('description')}</label>
    <fieldset><legend>Photos (jusqu'à ${C.MAX_PHOTOS})</legend>
      ${photos.length ? `<p class="small muted">Photos actuelles — cochez celles à retirer :</p><div class="previews">${photos.map((p, i) => `<label class="pv old"><img src="${photoUrl(p.filename)}" alt="">${i === 0 ? '<span class="first">Principale</span>' : ''}<span class="rm"><input type="checkbox" name="remove_photo" value="${p.id}"> Retirer</span></label>`).join('')}</div>` : ''}
      <input id="photos" name="photos" type="file" accept="image/*" multiple>
      <p class="muted small">Les photos sont réduites automatiquement avant l'envoi pour économiser vos données.</p>
      <div id="previews" class="previews"></div>${err('photos')}</fieldset>
    <div class="two"><label>Nom affiché *<input name="seller_name" maxlength="50" required value="${esc(v.seller_name)}" autocomplete="name">${err('seller_name')}</label>
    <label>Téléphone de contact *<div class="phone"><span>+242</span><input name="phone" type="tel" inputmode="tel" required value="${esc(v.phone)}" placeholder="06 123 45 67" autocomplete="tel"></div>${err('phone')}</label></div>
    <p class="muted small">Ce numéro sera affiché sur l'annonce pour que les acheteurs vous appellent ou vous écrivent sur WhatsApp.</p>
    <button class="btn btn-post big" type="submit" id="submitb">${ad ? 'Enregistrer les modifications' : 'Publier mon annonce'}</button>
    ${ad ? `<a class="btn btn-ghost big" href="/mes-annonces">Annuler</a>` : ''}
    <p id="formmsg" class="muted small"></p>
  </form>`;
  return layout(req, { title: ad ? 'Modifier mon annonce' : 'Déposer une annonce', body, scripts: '<script src="/static/post.js?v=2" defer></script>' });
}
function validate(b) {
  const e = {}; const v = {
    title: String(b.title || '').trim(), category: b.category, city: b.city, price: String(b.price ?? '').trim(),
    description: String(b.description || '').trim(), seller_name: String(b.seller_name || '').trim(), phone: String(b.phone || '').trim(),
  };
  if (v.title.length < 5 || v.title.length > 80) e.title = 'Le titre doit faire entre 5 et 80 caractères.';
  if (!catBySlug[v.category]) e.category = 'Choisissez une catégorie.';
  if (!C.CITIES.includes(v.city)) e.city = 'Choisissez une ville.';
  if (!/^\d{1,11}$/.test(v.price.replace(/\s/g, ''))) e.price = 'Indiquez un prix en FCFA (chiffres uniquement, 0 = à discuter).';
  if (v.description.length < 20 || v.description.length > 4000) e.description = 'La description doit faire au moins 20 caractères.';
  if (v.seller_name.length < 2 || v.seller_name.length > 50) e.seller_name = 'Indiquez votre nom (2 caractères minimum).';
  if (!normPhone(v.phone)) e.phone = 'Numéro invalide. Format attendu : 06 123 45 67 (9 chiffres, commençant par 04, 05, 06 ou 22).';
  return { v, e };
}
// Traite un envoi multipart (dépôt ou modification) : CSRF + validation + photos
function handleAdForm(req, res, { ad = null } = {}) {
  upload.array('photos', C.MAX_PHOTOS)(req, res, (uerr) => {
    const files = req.files || [];
    const cleanup = () => files.forEach((f) => fs.unlink(f.path, () => {}));
    const wantsJson = req.get('accept')?.includes('application/json');
    if (!auth.checkCsrf(req)) { cleanup(); return wantsJson ? res.status(403).json({ ok: false, errors: { _: 'Jeton de sécurité expiré : rechargez la page.' } }) : res.status(403).send('Jeton de sécurité invalide. Rechargez la page.'); }
    const { v, e } = validate(req.body || {});
    const existing = ad ? db.prepare('SELECT * FROM photos WHERE ad_id = ? ORDER BY position').all(ad.id) : [];
    const removeIds = new Set([].concat(req.body?.remove_photo || []).map(Number));
    const kept = existing.filter((p) => !removeIds.has(p.id));
    if (uerr) e.photos = uerr.code === 'LIMIT_FILE_SIZE' ? 'Une photo est trop lourde (6 Mo max).' : uerr.code === 'LIMIT_FILE_COUNT' || uerr.code === 'LIMIT_UNEXPECTED_FILE' ? `${C.MAX_PHOTOS} photos maximum.` : 'Erreur lors de l\'envoi des photos.';
    else if (kept.length + files.length > C.MAX_PHOTOS) e.photos = `${C.MAX_PHOTOS} photos maximum au total (retirez-en ou ajoutez-en moins).`;
    if (Object.keys(e).length) { cleanup(); return wantsJson ? res.status(400).json({ ok: false, errors: e }) : res.status(400).send(formPage(req, v, e, { ad, photos: existing })); }
    const price = parseInt(v.price.replace(/\s/g, ''), 10); const phone = normPhone(v.phone);
    // modération : mots interdits, pré-modération, refus -> nouvelle relecture
    const flagged = bannedWordsIn(v.title + ' ' + v.description);
    const premod = db.getSetting('premoderation') === '1';
    let status = ad ? ad.status : 'active'; let note = ad ? ad.moderation_note : null;
    if (ad && ad.status === 'hidden') { /* reste masquée : décision de la modération */ }
    else if (flagged.length) { status = db.getSetting('banned_words_action') === 'reject' ? 'rejected' : 'pending'; note = status === 'rejected' ? 'Contient des mots interdits' : null; }
    else if (!ad && premod) status = 'pending';
    else if (ad && ['rejected', 'pending'].includes(ad.status)) { status = 'pending'; note = null; }
    let id;
    if (ad) {
      id = ad.id;
      db.prepare('UPDATE ads SET title=?, category=?, city=?, price=?, description=?, seller_name=?, phone=?, status=?, moderation_note=?, flagged_words=? WHERE id = ?').run(v.title, v.category, v.city, price, v.description, v.seller_name, phone, status, note, flagged.join(', ') || null, id);
      const removed = existing.filter((p) => removeIds.has(p.id));
      for (const p of removed) db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
      if (!ad.is_example) deletePhotoFiles(removed);
      kept.forEach((p, i) => db.prepare('UPDATE photos SET position = ? WHERE id = ?').run(i, p.id));
    } else {
      const now = Date.now();
      id = db.prepare('INSERT INTO ads (title, category, city, price, description, seller_name, phone, user_id, created_at, expires_at, status, moderation_note, flagged_words) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(v.title, v.category, v.city, price, v.description, v.seller_name, phone, req.user.id, now, now + AD_TTL_DAYS * DAY, status, note, flagged.join(', ') || null).lastInsertRowid;
    }
    const ins = db.prepare('INSERT INTO photos (ad_id, filename, position) VALUES (?,?,?)');
    files.forEach((f, i) => ins.run(id, f.filename, kept.length + i));
    if (flagged.length) audit(null, 'mots_interdits', 'annonce', id, `${flagged.join(', ')} -> ${STATUS_FR[status]}`);
    const url = `/annonce/${id}?${ad ? 'modifie' : 'nouveau'}=1`;
    wantsJson ? res.json({ ok: true, url }) : res.redirect(303, url);
  });
}
app.get('/deposer', requireUser, (req, res) => res.send(formPage(req, { seller_name: req.user.display_name || '', phone: req.user.phone.replace(/^\+242/, '') })));
app.post('/deposer', requireUser, (req, res) => handleAdForm(req, res));
app.get('/annonce/:id/modifier', requireUser, (req, res) => {
  const ad = ownAd(req, res); if (!ad) return;
  const photos = db.prepare('SELECT * FROM photos WHERE ad_id = ? ORDER BY position').all(ad.id);
  res.send(formPage(req, { ...ad, price: String(ad.price) }, {}, { ad, photos }));
});
app.post('/annonce/:id/modifier', requireUser, (req, res) => { const ad = ownAd(req, res); if (ad) handleAdForm(req, res, { ad }); });

// ---------- administration (voir admin.js) ----------
require('./messages')(app, { db, C, esc, layout, page, csrfField, fmtPrice, fmtDate, photoUrl, firstPhotoStmt, audit, requireUser, bannedWordsIn, catBySlug });
require('./boosts')(app, { db, C, esc, layout, page, csrfField, fmtPrice, fmtDate, fmtDay, fmtPhone, normPhone, photoUrl, firstPhotoStmt, audit, requireUser, catBySlug, DAY });
require('./admin')(app, { db, C, esc, layout, page, csrfField, fmtPrice, fmtDate, fmtDay, fmtPhone, normPhone, catBySlug, photoUrl, firstPhotoStmt, audit, STATUS_FR, deletePhotoFiles, LIVE, safeNext, DAY, AD_TTL_DAYS });

app.use((req, res) => page(req, res, 404, 'Page introuvable', '<a class="btn" href="/">Retour à l\'accueil</a>'));
app.use((err, req, res, next) => { console.error(err); res.status(500).send('Erreur serveur'); });
// Comptes administrateurs : ADMIN_PHONES="+242060000001,+242069998877"
for (const raw of (process.env.ADMIN_PHONES || '').split(',').map((x) => x.trim()).filter(Boolean)) {
  const l = normPhone(raw); if (!l) { console.warn('ADMIN_PHONES : numéro ignoré', raw); continue; }
  db.prepare("INSERT INTO users (phone, role, created_at) VALUES (?, 'admin', ?) ON CONFLICT(phone) DO UPDATE SET role = 'admin'").run('+242' + l, Date.now());
}
if (sms.isDev) console.warn('⚠ SMS_PROVIDER=dev : les codes de connexion s\'affichent à l\'écran. Ne jamais exposer publiquement dans ce mode (n\'importe qui pourrait se connecter à n\'importe quel compte, y compris administrateur).');
if (!process.env.SESSION_SECRET) console.warn('⚠ SESSION_SECRET non défini : secret généré dans data/secret.key (les sessions seront perdues si ce fichier disparaît, p. ex. au redémarrage sur Render).');
if (process.env.NODE_ENV === 'production' && !GATED) console.warn('⚠ SITE_PASSWORD non défini : le site d\'essai est accessible à tous.');
app.listen(PORT, HOST, () => console.log(`${C.BRAND} en ligne sur http://${HOST}:${PORT}${GATED ? ' — protégé par mot de passe' : ''} (SMS : ${sms.name}, paiements : ${require('./payments').MODE})`));
