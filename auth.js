// Sessions (cookie signé httpOnly), CSRF et codes à usage unique (OTP) par SMS
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const sms = require('./sms');

const DAY = 86400000;
const SESSION_DAYS = 30;
const OTP_TTL = 10 * 60000;
const OTP_MAX_ATTEMPTS = 5;
const LIMITS = { phone10min: 3, phoneDay: 10, ipHour: 15 };

// Secret : SESSION_SECRET ou fichier généré une fois dans data/
const secretFile = path.join(__dirname, 'data', 'secret.key');
const SECRET = process.env.SESSION_SECRET || (fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8').trim()
  : (() => { const s = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(secretFile, s, { mode: 0o600 }); return s; })());

const hmac = (v) => crypto.createHmac('sha256', SECRET).update(String(v)).digest('base64url');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sign = (v) => `${v}.${hmac(v)}`;
const unsign = (s) => { if (!s) return null; const i = s.lastIndexOf('.'); if (i < 1) return null; const v = s.slice(0, i); return safeEq(hmac(v), s.slice(i + 1)) ? v : null; };

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} } }
  return out;
}
function setCookie(req, res, name, value, maxAgeMs) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (maxAgeMs != null) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : [prev]), parts.join('; ')]);
}

// Middleware : charge l'utilisateur + jeton CSRF (double cookie signé, valable aussi hors connexion)
function middleware(req, res, next) {
  const c = parseCookies(req); req.cookies = c;
  let cs = unsign(c.cs);
  if (!cs) { cs = crypto.randomBytes(16).toString('hex'); setCookie(req, res, 'cs', sign(cs), 365 * DAY); }
  req.csrfToken = hmac('csrf:' + cs);
  req.user = null;
  const tok = unsign(c.sid);
  if (tok) {
    const s = db.prepare('SELECT s.user_id, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha(tok));
    if (s && s.expires_at > Date.now() && !s.banned_at) req.user = s;
    else setCookie(req, res, 'sid', '', 0);
  }
  next();
}
const checkCsrf = (req) => !!req.body && typeof req.body._csrf === 'string' && safeEq(req.body._csrf, req.csrfToken);
function csrfGuard(req, res, next) { if (checkCsrf(req)) return next(); res.status(403).send('Jeton de sécurité invalide ou expiré. Revenez en arrière, rechargez la page et réessayez.'); }

function login(req, res, userId) {
  const tok = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(sha(tok), userId, Date.now(), Date.now() + SESSION_DAYS * DAY);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), userId);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  setCookie(req, res, 'sid', sign(tok), SESSION_DAYS * DAY);
}
function logout(req, res) {
  const tok = unsign(req.cookies.sid);
  if (tok) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(tok));
  setCookie(req, res, 'sid', '', 0);
}

// --- OTP ---
const codeHash = (phone, code) => hmac(`otp:${phone}:${code}`);
async function sendCode(phoneE164, ip, brand) {
  const now = Date.now();
  const n10 = db.prepare('SELECT COUNT(*) n FROM otp_codes WHERE phone = ? AND created_at > ?').get(phoneE164, now - 10 * 60000).n;
  const nDay = db.prepare('SELECT COUNT(*) n FROM otp_codes WHERE phone = ? AND created_at > ?').get(phoneE164, now - DAY).n;
  const nIp = db.prepare('SELECT COUNT(*) n FROM otp_codes WHERE ip = ? AND created_at > ?').get(ip, now - 3600000).n;
  if (n10 >= LIMITS.phone10min || nDay >= LIMITS.phoneDay) return { ok: false, error: 'Trop de codes demandés pour ce numéro. Réessayez dans quelques minutes.' };
  if (nIp >= LIMITS.ipHour) return { ok: false, error: 'Trop de demandes depuis votre connexion. Réessayez dans une heure.' };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare('UPDATE otp_codes SET used = 1 WHERE phone = ? AND used = 0').run(phoneE164); // un seul code valide à la fois
  db.prepare('INSERT INTO otp_codes (phone, code_hash, ip, expires_at, created_at) VALUES (?,?,?,?,?)').run(phoneE164, codeHash(phoneE164, code), ip, now + OTP_TTL, now);
  try { await sms.send(phoneE164, `${brand} : votre code de connexion est ${code}. Il expire dans 10 minutes. Ne le partagez avec personne.`); }
  catch (e) { console.error('Échec envoi SMS', e.message); return { ok: false, error: "L'envoi du SMS a échoué. Réessayez dans un instant." }; }
  return { ok: true, devCode: sms.isDev ? code : null };
}
function verifyCode(phoneE164, code) {
  const row = db.prepare('SELECT * FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(phoneE164);
  if (!row || row.expires_at < Date.now()) return { ok: false, error: 'Code expiré. Demandez un nouveau code.', expired: true };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, error: 'Trop de tentatives. Demandez un nouveau code.', expired: true };
  db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
  if (!/^\d{6}$/.test(code) || !safeEq(codeHash(phoneE164, code), row.code_hash)) {
    const left = OTP_MAX_ATTEMPTS - row.attempts - 1;
    return { ok: false, error: left > 0 ? `Code incorrect. Il vous reste ${left} essai${left > 1 ? 's' : ''}.` : 'Trop de tentatives. Demandez un nouveau code.', expired: left <= 0 };
  }
  db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(row.id);
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phoneE164);
  if (!user) { const id = db.prepare('INSERT INTO users (phone, created_at) VALUES (?, ?)').run(phoneE164, Date.now()).lastInsertRowid; user = { id, isNew: true }; }
  return { ok: true, userId: user.id, isNew: !!user.isNew };
}

module.exports = { middleware, checkCsrf, csrfGuard, login, logout, sendCode, verifyCode, sign, unsign, setCookie, SECRET };
