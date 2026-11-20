// Accès restreint au site entier pendant la phase d'essai : actif si SITE_PASSWORD est défini.
// - Page « /acces » (mot de passe -> cookie signé httpOnly, 30 jours) ou, à défaut, HTTP Basic Auth (n'importe quel identifiant).
// - Exemptés : /healthz (sonde Render) et ce qu'affiche la page d'accès : feuille de style, polices, logos et icônes (aucune donnée).
// - Comparaison en temps constant ; limite de tentatives échouées : 10 / 15 min par IP et 200 / 15 min au total.
const crypto = require('crypto');
const auth = require('./auth');
const brand = require('./brand');

const PASSWORD = process.env.SITE_PASSWORD || '';
const COOKIE = 'gate';
const WINDOW = 15 * 60000, PER_IP = 10, GLOBAL = 200;
const EXEMPT = new Set(['/healthz', '/static/style.css', '/acces', '/favicon.ico', '/static/manifest.webmanifest']);
const EXEMPT_DIRS = /^\/static\/(fonts|brand)\/[\w-]+(\.[\w-]+)+$/; // polices et fichiers de marque publics
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
const passOk = (v) => crypto.timingSafeEqual(digest(v), digest(PASSWORD)); // longueur fixe : pas de fuite de longueur
// Le cookie dépend du mot de passe : en changer invalide tous les accès donnés.
const token = () => auth.sign('ok:' + digest('gate:' + PASSWORD).toString('base64url').slice(0, 22));
const fails = new Map(); let globalFails = [];
const recent = (arr) => arr.filter((t) => t > Date.now() - WINDOW);
function limited(ip) { globalFails = recent(globalFails); return recent(fails.get(ip) || []).length >= PER_IP || globalFails.length >= GLOBAL; }
function fail(ip) { fails.set(ip, [...recent(fails.get(ip) || []), Date.now()]); globalFails.push(Date.now()); if (fails.size > 5000) fails.clear(); }
const cookieOf = (req) => { for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i).trim() === COOKIE) { try { return decodeURIComponent(p.slice(i + 1).trim()); } catch { return ''; } } } return ''; };
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[^\\\s]*$/.test(n) && !n.startsWith('/acces') ? n : '/');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function gatePage(next, error) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Accès réservé — OMONI</title>${brand.HEAD}<link rel="stylesheet" href="/static/style.css?v=6"></head>
<body><div class="stripe" aria-hidden="true"></div><main class="wrap gate">
<div class="gate-head"><h1>${brand.wordmarkA('gate-o')}</h1><p class="muted">Version d'essai — accès réservé</p></div>
${error ? `<div class="notice bad" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="/acces" class="pform">
<input type="hidden" name="next" value="${esc(next)}">
<label for="pw">Mot de passe du site</label>
<input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
<button class="btn big" type="submit">Entrer</button></form>
<p class="muted" style="text-align:center;font-size:14px">Ce site est en phase de test. Demandez le mot de passe à l'équipe OMONI.</p>
</main></body></html>`;
}

module.exports = function gate(app, express) {
  app.get('/healthz', (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true }));
  if (!PASSWORD) return false;
  app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
  app.get('/acces', (req, res) => res.set('Cache-Control', 'no-store').send(gatePage(safeNext(req.query.next))));
  app.post('/acces', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const next = safeNext(req.body?.next);
    if (limited(req.ip)) return res.status(429).send(gatePage(next, 'Trop de tentatives. Réessayez dans 15 minutes.'));
    if (!passOk(req.body?.password || '')) { fail(req.ip); return res.status(401).send(gatePage(next, 'Mot de passe incorrect.')); }
    auth.setCookie(req, res, COOKIE, token(), 30 * 86400000);
    res.redirect(303, next);
  });
  app.use((req, res, next) => {
    if (EXEMPT.has(req.path) || (req.method === 'GET' && EXEMPT_DIRS.test(req.path))) return next();
    const c = cookieOf(req);
    if (c && c.length === token().length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(token()))) return next();
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) { // repli : HTTP Basic Auth (identifiant libre)
      if (limited(req.ip)) return res.status(429).send('Trop de tentatives.');
      const dec = Buffer.from(h.slice(6), 'base64').toString(); const pw = dec.slice(dec.indexOf(':') + 1);
      if (passOk(pw)) return next();
      fail(req.ip);
    }
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return res.redirect(302, '/acces?next=' + encodeURIComponent(req.originalUrl));
    res.set('WWW-Authenticate', 'Basic realm="OMONI (essai)", charset="UTF-8"').status(401).send('Accès réservé');
  });
  return true;
};
