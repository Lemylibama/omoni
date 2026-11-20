// Tests du mot de passe du site (sans navigateur). Usage : SITE_PASSWORD=… node tests/gate.js
// Sans SITE_PASSWORD : vérifie seulement que /healthz répond et que le site est ouvert.
const B = process.env.BASE_URL || 'http://localhost:3000'; const PW = process.env.SITE_PASSWORD;
const ok = (c, m) => { if (!c) throw new Error('ÉCHEC: ' + m); console.log('✔', m); };
let ipN = 0; const ip = () => `198.51.100.${++ipN}`; // X-Forwarded-For distinct par test (trust proxy)
const get = (u, h = {}) => fetch(B + u, { redirect: 'manual', headers: { Accept: 'text/html', 'X-Forwarded-For': h.ip || ip(), ...h } });
const tryPw = (pw, xff, next = '/annonces') => fetch(B + '/acces', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': xff }, body: new URLSearchParams({ password: pw, next }) });
(async () => {
  const hz = await fetch(B + '/healthz'); ok(hz.status === 200 && (await hz.json()).ok, '/healthz : 200');
  if (!PW) { ok((await get('/')).status === 200, 'sans SITE_PASSWORD : site ouvert'); ok((await get('/acces')).status === 404, 'sans SITE_PASSWORD : pas de page /acces'); return console.log('GATE OK (désactivé)'); }
  let r = await get('/annonces?cat=mode'); ok(r.status === 302 && r.headers.get('location') === '/acces?next=%2Fannonces%3Fcat%3Dmode', 'page HTML -> redirection vers /acces');
  ok((await get('/static/style.css')).status === 200, 'feuille de style accessible (page d\'accès)');
  for (const u of ['/static/fonts/bricolage-grotesque-800.woff2', '/static/brand/favicon.svg', '/static/brand/favicon-32.png']) ok((await get(u)).status === 200, `${u} accessible (page d'accès)`);
  for (const u of ['/static/fonts/../app.js', '/static/brand/x/../../app.js', '/static/post.js']) ok([302, 401, 404].includes((await get(u)).status) && (await get(u)).status !== 200, `${u} non exempté`);
  for (const u of ['/static/app.js', '/uploads/ex01-1.jpg', '/annonce/1', '/admin', '/connexion']) ok([302, 401].includes((await get(u)).status), `${u} protégé`);
  r = await fetch(B + '/webhooks/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(r.status === 401 && /Basic/.test(r.headers.get('www-authenticate')), 'callbacks (webhooks) protégés : 401 + Basic');
  r = await get('/acces'); const html = await r.text(); ok(r.status === 200 && html.includes('Mot de passe du site') && html.includes('noindex'), 'page d\'accès en français, noindex');
  const me = ip();
  r = await tryPw('mauvais', me); ok(r.status === 401 && (await r.text()).includes('Mot de passe incorrect'), 'mauvais mot de passe refusé');
  r = await tryPw(PW, ip(), '//evil.example'); ok(r.headers.get('location') === '/', 'redirection externe neutralisée');
  r = await tryPw(PW, ip()); const ck = r.headers.get('set-cookie') || '';
  ok(r.status === 303 && r.headers.get('location') === '/annonces' && /gate=.*HttpOnly/.test(ck), 'bon mot de passe -> cookie httpOnly + retour à la page demandée');
  const cookie = ck.split(';')[0];
  ok((await get('/annonces', { Cookie: cookie })).status === 200, 'avec le cookie : accès au site');
  ok((await get('/annonces', { Cookie: cookie.slice(0, -2) + 'xx' })).status === 302, 'cookie falsifié refusé');
  const basic = (pw) => ({ Authorization: 'Basic ' + Buffer.from('x:' + pw).toString('base64') });
  ok((await get('/annonces', basic(PW))).status === 200, 'HTTP Basic Auth (repli) : accès');
  ok((await get('/annonces', basic('nope'))).status === 302, 'HTTP Basic Auth mauvais mot de passe : refusé');
  const att = ip(); for (let i = 0; i < 10; i++) await tryPw('faux' + i, att);
  r = await tryPw(PW, att); ok(r.status === 429, 'après 10 échecs : 429, même avec le bon mot de passe');
  ok((await tryPw(PW, ip())).status === 303, 'autre IP non bloquée');
  console.log('GATE OK');
})().catch((e) => { console.error(e.message); process.exit(1); });
