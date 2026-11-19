// Test de bout en bout (navigateur headless) — nécessite playwright-core + Chrome, serveur sur localhost:3000 en SMS_PROVIDER=dev.
// Après exécution : node tests/clean-test-data.js
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.join(__dirname, '..');
const db = new DatabaseSync(path.join(ROOT, 'data', 'annonces.db'));
const OTHER = db.prepare('SELECT id FROM ads WHERE is_example=1 ORDER BY id LIMIT 1').get().id;
const B = process.env.BASE_URL || 'http://localhost:3000', D = path.join(ROOT, 'screenshots') + '/';
const IMG = (f) => path.join(ROOT, 'seed', 'images', f);
const SHOTS = !process.argv.includes('--no-shots');
const ok = (c, m) => { if (!c) throw new Error('ÉCHEC: ' + m); console.log('✔', m); };
const statusOf = (id) => db.prepare('SELECT status FROM ads WHERE id=?').get(id)?.status;

(async () => {
  const br = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  if (process.env.SITE_PASSWORD) { // site protégé : on s'authentifie en HTTP Basic sur tous les contextes
    const nc = br.newContext.bind(br); const H = { Authorization: 'Basic ' + Buffer.from('test:' + process.env.SITE_PASSWORD).toString('base64') };
    br.newContext = (o = {}) => nc({ ...o, extraHTTPHeaders: { ...H, ...(o.extraHTTPHeaders || {}) } });
  }
  const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' };
  const ctx = await br.newContext(mobile);
  const p = await ctx.newPage();
  const anon = await br.newContext(); const ap = await anon.newPage();
  const login = async (page, phone, next = '/') => {
    await page.goto(`${B}/connexion?next=${encodeURIComponent(next)}`);
    await page.fill('input[name=phone]', phone); await page.click('form.pform button[type=submit]');
    await page.waitForURL(/connexion\/code/); const code = (await page.textContent('.devcode')).trim();
    await page.fill('input[name=code]', code); await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/connexion')), page.click('form.pform button')]);
  };
  const post = async (page, title, desc = 'Ventilateur sur pied, 3 vitesses, fonctionne très bien. Annonce de test automatique.', photos = [IMG('ex12-1.jpg'), IMG('ex11-1.jpg')]) => {
    await page.goto(B + '/deposer');
    await page.fill('input[name=title]', title);
    await page.selectOption('[name=category]', 'maison'); await page.selectOption('[name=city]', 'Pointe-Noire');
    await page.fill('[name=price]', '30000'); await page.fill('textarea[name=description]', desc);
    if (photos.length) { await page.setInputFiles('#photos', photos); await page.waitForSelector(`#previews .pv:nth-child(${photos.length}) img`); }
    await page.fill('input[name=seller_name]', 'Franck Test');
    await Promise.all([page.waitForURL(/annonce\/\d+\?nouveau=1/), page.click('#submitb')]);
    return Number(page.url().match(/annonce\/(\d+)/)[1]);
  };
  const csrfOf = async (page) => page.locator('input[name=_csrf]').first().inputValue();
  const publicStatus = async (id) => (await ap.goto(`${B}/annonce/${id}`)).status();

  // ===== Comptes vendeurs =====
  await p.goto(B + '/', { waitUntil: 'networkidle' }); if (SHOTS) await p.screenshot({ path: D + '01-accueil.png', fullPage: true });
  await p.goto(`${B}/annonce/${OTHER}`, { waitUntil: 'networkidle' }); if (SHOTS) await p.screenshot({ path: D + '03-annonce.png' });
  await p.goto(B + '/');
  ok(await p.isVisible('a.login-link'), 'header: "Se connecter" quand déconnecté');
  await p.goto(B + '/deposer'); ok(p.url().includes('/connexion?next=%2Fdeposer'), 'déposer -> redirection connexion');
  if (SHOTS) await p.screenshot({ path: D + '05-connexion.png' });
  await p.fill('input[name=phone]', '12345'); await p.click('form.pform button[type=submit]');
  ok(await p.isVisible('.notice.bad'), 'numéro invalide refusé');
  await p.fill('input[name=phone]', '06 999 88 77'); await p.click('form.pform button[type=submit]');
  await p.waitForURL(/connexion\/code/);
  const code = (await p.textContent('.devcode')).trim(); ok(/^\d{6}$/.test(code), 'code affiché en mode test');
  if (SHOTS) await p.screenshot({ path: D + '06-code.png' });
  const row = db.prepare("SELECT code_hash FROM otp_codes WHERE phone='+242069998877' ORDER BY id DESC").get();
  ok(row && !row.code_hash.includes(code), 'code stocké haché');
  await p.fill('input[name=code]', code === '000000' ? '111111' : '000000'); await p.click('form.pform button');
  ok((await p.textContent('.notice.bad')).includes('incorrect'), 'mauvais code refusé (essais restants)');
  await p.fill('input[name=code]', code); await p.click('form.pform button');
  await p.waitForURL(B + '/deposer'); ok(true, 'connexion OK, retour au formulaire');
  ok(await p.inputValue('input[name=phone]') === '069998877', 'téléphone pré-rempli avec celui du compte');
  if (SHOTS) await p.screenshot({ path: D + '04-deposer.png', fullPage: true });
  const sid = (await ctx.cookies()).find((c) => c.name === 'sid');
  ok(sid && sid.httpOnly && sid.expires * 1000 > Date.now() + 29 * 86400000, 'cookie de session httpOnly, 30 jours');
  const id = await post(p, 'Ventilateur sur pied Binatone');
  ok(await p.isVisible('.notice.info'), `annonce ${id} publiée et rattachée au compte`);
  await p.goto(`${B}/annonce/${id}/modifier`);
  await p.fill('input[name=title]', 'Ventilateur Binatone 16 pouces'); await p.fill('[name=price]', '25000');
  await p.check('.pv.old:nth-child(2) input[type=checkbox]');
  await p.setInputFiles('#photos', IMG('ex07-1.jpg')); await p.waitForSelector('#previews .pv img');
  await Promise.all([p.waitForURL(/modifie=1/), p.click('#submitb')]);
  ok((await p.textContent('h1')).includes('16 pouces') && (await p.textContent('.price')).includes('25 000'), 'modification titre + prix');
  ok(db.prepare('SELECT COUNT(*) n FROM photos WHERE ad_id=?').get(id).n === 2, 'photos : 1 retirée, 1 ajoutée (2 au total)');
  // renouvellement : délai de 24 h
  await p.goto(B + '/mes-annonces');
  ok((await p.textContent(`#ad-${id}`)).includes('Renouvelable dans'), 'renouveler : bouton désactivé pendant 24 h');
  const csrfS = await csrfOf(p);
  const createdBefore = db.prepare('SELECT created_at FROM ads WHERE id=?').get(id).created_at;
  await p.request.post(`${B}/annonce/${id}/renouveler`, { form: { _csrf: csrfS } });
  ok(db.prepare('SELECT created_at FROM ads WHERE id=?').get(id).created_at === createdBefore, 'renouveler < 24 h refusé côté serveur');
  db.prepare('UPDATE ads SET created_at = created_at - 864000000, expires_at = expires_at - 864000000 WHERE id=?').run(id);
  const before = db.prepare('SELECT expires_at FROM ads WHERE id=?').get(id).expires_at;
  await p.goto(B + '/mes-annonces');
  await Promise.all([p.waitForURL(/renouvele=1/), p.click(`#ad-${id} form[action$=renouveler] button`)]);
  const after = db.prepare('SELECT created_at, expires_at FROM ads WHERE id=?').get(id);
  ok(after.expires_at > before + 9 * 86400000 && Date.now() - after.created_at < 60000, 'renouveler après 24 h : date remise à maintenant, +60 j');
  ok((await p.textContent(`#ad-${id}`)).includes('Renouvelable dans'), 'nouveau délai de 24 h après renouvellement');
  db.prepare('UPDATE ads SET expires_at = ? WHERE id=?').run(Date.now() - 1000, id);
  ok(await publicStatus(id) === 404, 'annonce expirée masquée au public');
  await p.goto(B + '/mes-annonces'); ok((await p.textContent(`#ad-${id}`)).includes('Expirée'), 'expirée affichée dans Mes annonces');
  await p.click(`#ad-${id} form[action$=renouveler] button`); await p.waitForURL(/renouvele=1/);
  ok(await publicStatus(id) === 200, 'expirée -> renouvelable immédiatement, de nouveau visible');
  await p.click(`#ad-${id} form[action$=vendu] button`); await p.waitForURL(/vendu=1/);
  ok((await p.textContent(`#ad-${id}`)).includes('Vendu'), 'marquée vendue');
  await ap.goto(B + '/annonces?cat=maison'); ok(!(await ap.content()).includes(`/annonce/${id}"`), 'vendue retirée de la liste');
  await p.click(`#ad-${id} form[action$=vendu] button`); await p.waitForURL(/vendu=1/);
  const id2 = await post(p, 'Chaise en plastique à supprimer', undefined, [IMG('ex11-1.jpg')]);
  await p.goto(B + '/mes-annonces');
  if (SHOTS) await p.screenshot({ path: D + '07-mes-annonces.png', fullPage: true });
  await p.click(`#ad-${id2} a[href$=supprimer]`); await p.waitForURL(/supprimer$/);
  await Promise.all([p.waitForURL(/supprime=1/), p.click('button.btn-danger')]);
  ok(!db.prepare('SELECT 1 FROM ads WHERE id=?').get(id2), 'suppression après confirmation');
  await p.goto(B + '/'); await p.locator('.cardw .fav').first().click(); await p.waitForFunction(() => document.querySelector('.cardw .fav').classList.contains('on'));
  await p.goto(B + '/mes-favoris'); ok(await p.locator('.grid .cardw').count() === 1, 'favori ajouté (♥) et listé dans Mes favoris');
  await p.locator('.cardw .fav').first().click(); await p.waitForFunction(() => !document.querySelector('.cardw .fav').classList.contains('on'));
  await p.goto(B + '/mes-favoris'); ok(await p.locator('.grid .cardw').count() === 0, 'favori retiré');
  ok((await p.goto(`${B}/annonce/${OTHER}/modifier`)).status() === 403, "modifier l'annonce d'un autre -> 403");
  const csrf = await csrfOf(p);
  ok((await p.request.post(`${B}/annonce/${OTHER}/supprimer`, { form: { _csrf: csrf }, maxRedirects: 0 })).status() === 403, "supprimer l'annonce d'un autre -> 403");
  ok((await p.request.post(`${B}/annonce/${id}/vendu`, { form: { _csrf: 'faux' }, maxRedirects: 0 })).status() === 403, 'jeton CSRF invalide -> 403');

  // ===== Administration =====
  ok((await p.goto(B + '/admin')).status() === 403, 'non-admin : /admin -> 403');
  ok((await p.request.post(`${B}/admin/reglages`, { form: { _csrf: csrf, premoderation: '1' }, maxRedirects: 0 })).status() === 403, 'non-admin : POST /admin/reglages -> 403');
  ok(!(await p.content()).includes('href="/admin"'), "non-admin : pas de lien Administration dans le menu");
  const actx = await br.newContext(mobile); const a = await actx.newPage();
  await login(a, '06 000 00 01', '/admin');
  ok(a.url().endsWith('/admin') && (await a.textContent('h1')).includes('Tableau de bord'), 'admin de démo connecté -> tableau de bord');
  ok((await a.request.post(`${B}/admin/reglages`, { form: { _csrf: 'faux', premoderation: '1' }, maxRedirects: 0 })).status() === 403, 'admin : CSRF exigé sur /admin');
  // signalement -> masquer -> rétablir
  await ap.goto(`${B}/annonce/${id}`); await ap.click('.report summary'); await ap.selectOption('select[name=reason]', 'Arnaque / fraude');
  await ap.fill('textarea[name=details]', 'Test e2e'); await Promise.all([ap.waitForURL(/signale=1/), ap.click('.report button')]);
  await a.goto(B + '/admin/signalements'); ok(await a.isVisible(`.rgroup #ad-${id}`), 'signalement visible dans la file, regroupé par annonce');
  const grp = a.locator('.rgroup', { has: a.locator(`#ad-${id}`) });
  await grp.locator('summary', { hasText: 'Masquer' }).click(); await grp.locator('input[name=reason]').first().fill('Annonce suspecte (test)');
  await Promise.all([a.waitForURL(/ok=/), grp.locator('form[action$=masquer] button').click()]);
  ok(statusOf(id) === 'hidden' && await publicStatus(id) === 404, 'admin : annonce masquée (404 au public)');
  await p.goto(B + '/mes-annonces'); ok((await p.textContent(`#ad-${id}`)).includes('Annonce suspecte (test)'), 'vendeur : motif de masquage affiché');
  await a.goto(`${B}/admin/annonces?statut=hidden`); await Promise.all([a.waitForURL(/ok=/), a.click(`#ad-${id} form[action$=retablir] button`)]);
  ok(statusOf(id) === 'active' && await publicStatus(id) === 200, 'admin : annonce rétablie');
  await a.goto(B + '/admin/signalements?vue=historique'); ok((await a.content()).includes('Test e2e'), 'signalement traité dans l\'historique');
  // pré-modération
  await a.goto(B + '/admin/moderation'); await a.check('input[name=premoderation]');
  await Promise.all([a.waitForURL(/ok=/), a.click('form[action="/admin/reglages"] button')]);
  const id3 = await post(p, 'Matelas 2 places presque neuf', 'Matelas deux places, utilisé 6 mois, très propre. Annonce de test automatique.', []);
  ok(statusOf(id3) === 'pending' && (await p.textContent('.notice.info')).includes('après validation'), 'pré-modération : nouvelle annonce en attente');
  ok(await publicStatus(id3) === 404, 'annonce en attente invisible au public');
  await a.goto(B + '/admin/moderation'); await Promise.all([a.waitForURL(/ok=/), a.click(`#ad-${id3} form[action$=approuver] button`)]);
  ok(statusOf(id3) === 'active' && await publicStatus(id3) === 200, 'Approuver -> publiée');
  const id4 = await post(p, 'Table basse en verre', 'Table basse en verre trempé, bon état général. Annonce de test automatique.', []);
  await a.goto(B + '/admin/moderation'); await a.click(`#ad-${id4} summary:has-text("Refuser")`);
  await a.fill(`#ad-${id4} form[action$=refuser] input[name=reason]`, 'Photos manquantes');
  await Promise.all([a.waitForURL(/ok=/), a.click(`#ad-${id4} form[action$=refuser] button`)]);
  await p.goto(B + '/mes-annonces');
  ok(statusOf(id4) === 'rejected' && (await p.textContent(`#ad-${id4}`)).includes('Photos manquantes'), 'Refuser -> motif affiché au vendeur');
  await a.goto(B + '/admin/moderation'); await a.uncheck('input[name=premoderation]');
  // mots interdits
  await a.fill('textarea[name=banned_words]', 'faux billets\narnaque');
  await Promise.all([a.waitForURL(/ok=/), a.click('form[action="/admin/reglages"] button')]);
  const id5 = await post(p, 'Lot de FAUX BILLETS', 'Vends des faux billets très réalistes, livraison discrète. Test automatique.', []);
  ok(statusOf(id5) === 'pending' && db.prepare('SELECT flagged_words f FROM ads WHERE id=?').get(id5).f.includes('faux billets'), 'mots interdits (sans accents/majuscules) -> en attente + mots signalés');
  await a.goto(B + '/admin/moderation'); ok((await a.textContent(`#ad-${id5}`)).includes('Mots interdits'), 'admin : mots détectés affichés dans la file');
  await a.selectOption('select[name=banned_words_action]', 'reject'); await Promise.all([a.waitForURL(/ok=/), a.click('form[action="/admin/reglages"] button')]);
  const id6 = await post(p, 'Téléphone pas cher', 'Ce n’est pas une Arnaque, payez d’abord par Mobile Money. Test automatique.', []);
  ok(statusOf(id6) === 'rejected', 'action « refuser » : annonce refusée automatiquement');
  await p.goto(`${B}/annonce/${id3}/modifier`); await p.fill('textarea[name=description]', 'Matelas deux places — attention arnaque, test de modification automatique.');
  await Promise.all([p.waitForURL(/modifie=1/), p.click('#submitb')]);
  ok(statusOf(id3) === 'rejected', 'modification contenant un mot interdit -> re-modérée');
  // suppression par l'admin
  await a.goto(`${B}/admin/annonces?id=${id6}`); await Promise.all([a.waitForURL(/ok=/), a.click(`#ad-${id6} form[action$=supprimer] button`)]);
  ok(!db.prepare('SELECT 1 FROM ads WHERE id=?').get(id6), 'admin : annonce supprimée');
  await a.goto(`${B}/admin/annonces?tel=069998877`); ok(await a.locator('.mylist .myad').count() >= 4, 'admin : recherche des annonces par téléphone du vendeur');
  // bannissement
  const sellerId = db.prepare("SELECT id FROM users WHERE phone='+242069998877'").get().id;
  await a.goto(`${B}/admin/utilisateurs?q=069998877`); await a.click(`a[href="/admin/utilisateurs/${sellerId}"]`);
  await a.click('summary:has-text("Bannir")'); await a.fill('form[action$=bannir] input[name=reason]', 'Fraude répétée (test)');
  await Promise.all([a.waitForURL(/ok=/), a.click('form[action$=bannir] button')]);
  ok((await p.goto(B + '/mes-annonces')).url().includes('/connexion'), 'banni : session invalidée');
  ok(await publicStatus(id) === 404, 'banni : ses annonces sont masquées');
  await p.goto(B + '/connexion'); await p.fill('input[name=phone]', '069998877'); await p.click('form.pform button[type=submit]');
  ok((await p.textContent('.notice.bad')).includes('suspendu'), 'banni : connexion refusée (« compte suspendu »)');
  await a.click('form[action$=debannir] button'); await a.waitForURL(/ok=/);
  ok(await publicStatus(id) === 200, 'débanni : annonces de nouveau visibles');
  await login(p, '069998877', '/mes-annonces'); ok(p.url().includes('/mes-annonces'), 'débanni : connexion de nouveau possible');
  // journal
  await a.goto(B + '/admin/journal'); const j = await a.textContent('main');
  for (const t of ['Annonce masquée', 'Annonce rétablie', 'Annonce approuvée', 'Annonce refusée', 'Annonce supprimée', 'Utilisateur banni', 'Bannissement levé', 'Réglages modifiés', 'Mots interdits détectés'])
    ok(j.includes(t), `journal : « ${t} »`);
  ok(j.includes('+242 06 000 00 01'), "journal : l'administrateur auteur est indiqué");
  // ===== Messagerie =====
  const PRINCE = db.prepare("SELECT id FROM users WHERE phone='+242055551234'").get().id;
  const pAds = db.prepare('SELECT id FROM ads WHERE user_id=? AND is_example=1 ORDER BY id').all(PRINCE).map((r) => r.id);
  const adM = pAds[1], adM2 = pAds[2];
  await ap.goto(`${B}/annonce/${adM}`); ok(await ap.isVisible('a.btn-msg'), 'messagerie : bouton « Envoyer un message » sur une annonce');
  await ap.click('a.btn-msg'); ok(ap.url().includes('/connexion?next=%2Fannonce%2F' + adM + '%2Fcontacter'), 'non connecté -> connexion puis retour au message');
  const sctx = await br.newContext(mobile); const s = await sctx.newPage();
  await login(s, '05 555 12 34', `/annonce/${adM}`);
  ok(!(await s.isVisible('a.btn-msg')), "pas de bouton message pour le propriétaire de l'annonce");
  db.prepare("UPDATE ads SET status='sold' WHERE id=?").run(adM2); await p.goto(`${B}/annonce/${adM2}`);
  ok(!(await p.isVisible('a.btn-msg')), 'pas de bouton message sur une annonce vendue'); db.prepare("UPDATE ads SET status='active' WHERE id=?").run(adM2);
  await p.goto(`${B}/annonce/${adM}`); await p.click('a.btn-msg'); await p.waitForURL(/contacter$/);
  ok((await p.textContent('.notice.test')).includes('Mobile Money'), 'avertissement arnaques Mobile Money affiché');
  await p.fill('textarea[name=body]', 'Bonjour, est-ce toujours disponible ? Mon WhatsApp : 06 999 88 77');
  await Promise.all([p.waitForURL(/\/messages\/\d+$/), p.click('form.pform button')]);
  const cid = Number(p.url().match(/messages\/(\d+)/)[1]);
  ok((await p.textContent('#bubbles')).includes('06 999 88 77'), 'conversation créée, numéro de téléphone autorisé dans le message');
  await p.goto(`${B}/annonce/${adM}/contacter`); ok(p.url().endsWith(`/messages/${cid}`), 'une seule conversation par (annonce, acheteur)');
  await s.goto(B + '/'); ok((await s.textContent('#hdr-unread')).trim() === '1', 'vendeur : badge 1 non lu dans le header');
  await s.goto(B + '/messages'); ok(await s.isVisible(`a.conv.unread[href="/messages/${cid}"] .badge`), 'boîte de réception : conversation non lue avec badge');
  if (SHOTS) await s.screenshot({ path: D + '11-messages.png', fullPage: true });
  await s.click(`a[href="/messages/${cid}"]`); await s.waitForURL(/messages\/\d+$/);
  ok(!(await s.isVisible('#hdr-unread')), 'conversation ouverte -> plus de non lu');
  await p.goto(`${B}/messages/${cid}`); // page ouverte : l'actualisation automatique doit afficher la réponse
  await s.fill('#sendf textarea', 'Oui, toujours disponible. Je suis à Tié-Tié, passez quand vous voulez.'); await s.click('#sendf button');
  await s.waitForSelector('.bubble.me:has-text("Tié-Tié")'); ok(true, 'réponse envoyée sans rechargement (JS)');
  await p.waitForSelector('.bubble.them:has-text("Tié-Tié")', { timeout: 15000 }); ok(true, 'acheteur : réponse reçue par actualisation automatique (≤ 10 s)');
  if (SHOTS) { await s.reload(); await s.screenshot({ path: D + '12-conversation.png', fullPage: true }); }
  const csP = await csrfOf(p), csS = await csrfOf(s);
  const r0 = await p.request.post(`${B}/messages/${cid}`, { form: { _csrf: csP, body: 'Envoi sans JavaScript' }, maxRedirects: 0 });
  ok(r0.status() === 303, 'envoi sans JS : formulaire + redirection');
  ok(db.prepare('SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.id = ? AND m.sender_id != c.seller_id AND m.id > c.seller_last_read').get(cid).n === 1, 'non lus côté vendeur : 1');
  ok((await p.request.post(`${B}/messages/${cid}`, { form: { _csrf: csP, body: 'x'.repeat(1001) }, headers: { Accept: 'application/json' } })).status() === 400, 'message > 1000 caractères refusé');
  ok((await p.request.post(`${B}/messages/${cid}`, { form: { _csrf: 'faux', body: 'test' } })).status() === 403, 'messagerie : CSRF exigé');
  ok((await a.goto(`${B}/messages/${cid}`)).status() === 403, 'non-participant : lecture -> 403');
  ok((await a.request.get(`${B}/messages/${cid}/nouveaux?apres=0`)).status() === 403, 'non-participant : actualisation -> 403');
  ok((await a.request.post(`${B}/messages/${cid}`, { form: { _csrf: await csrfOf(a), body: 'intrus' } })).status() === 403, 'non-participant : envoi -> 403');
  // blocage
  await s.goto(`${B}/messages/${cid}`); await s.click('.chat-opts summary'); await Promise.all([s.waitForURL(/bloque=1/), s.click('form[action$=bloquer] button')]);
  const rb = await p.request.post(`${B}/messages/${cid}`, { form: { _csrf: csP, body: 'Vous êtes là ?' }, headers: { Accept: 'application/json' } });
  ok(rb.status() === 400 && (await rb.json()).error.includes('ne souhaite plus'), 'bloqué : ne peut plus écrire');
  ok((await p.goto(`${B}/annonce/${adM2}/contacter`)).status() === 403, 'bloqué : ne peut pas contacter le vendeur sur une autre annonce');
  await s.goto(`${B}/messages/${cid}`); await s.click('.chat-opts summary'); await Promise.all([s.waitForURL(/bloque=0/), s.click('form[action$=bloquer] button')]);
  ok((await p.request.post(`${B}/messages/${cid}`, { form: { _csrf: csP, body: 'Merci !' }, headers: { Accept: 'application/json' } })).ok(), 'débloqué : peut de nouveau écrire');
  // mots interdits dans les messages
  await a.goto(B + '/admin/moderation'); await a.fill('textarea[name=banned_words]', 'arnaque'); await a.selectOption('select[name=banned_words_action]', 'pending');
  await Promise.all([a.waitForURL(/ok=/), a.click('form[action="/admin/reglages"] button')]);
  ok((await s.request.post(`${B}/messages/${cid}`, { form: { _csrf: csS, body: "Ce n'est pas une arnaque, envoyez l'acompte" }, headers: { Accept: 'application/json' } })).ok(), 'mot interdit : message envoyé (mode « en attente »)…');
  ok(db.prepare("SELECT COUNT(*) n FROM conversation_reports WHERE conversation_id=? AND reporter_id IS NULL AND status='open'").get(cid).n === 1, '… et conversation signalée automatiquement à la modération');
  await a.selectOption('select[name=banned_words_action]', 'reject'); await Promise.all([a.waitForURL(/ok=/), a.click('form[action="/admin/reglages"] button')]);
  const rr = await s.request.post(`${B}/messages/${cid}`, { form: { _csrf: csS, body: 'arnaque encore' }, headers: { Accept: 'application/json' } });
  ok(rr.status() === 400, 'mot interdit (mode « refuser ») : message bloqué');
  // signalement par un participant + admin
  await p.goto(`${B}/messages/${cid}`); await p.click('.chat-opts summary'); await p.selectOption('form[action$=signaler] select', { index: 0 });
  await p.fill('form[action$=signaler] textarea', 'Test e2e conversation'); await Promise.all([p.waitForURL(/signale=1/), p.click('form[action$=signaler] button')]);
  await a.goto(B + '/admin/signalements'); ok(await a.isVisible(`#conv-${cid}`), 'admin : conversation signalée dans la file');
  const exampleConv = db.prepare('SELECT id FROM conversations WHERE is_example=1 LIMIT 1').get().id;
  ok((await a.goto(`${B}/admin/conversations/${exampleConv}`)).status() === 403, 'admin : conversation NON signalée illisible (vie privée)');
  await a.goto(`${B}/admin/conversations/${cid}`); ok((await a.textContent('.bubbles')).includes('Tié-Tié') && (await a.textContent('.bubbles')).includes('Mots interdits'), 'admin : lecture de la conversation signalée (mots interdits surlignés)');
  await Promise.all([a.waitForURL(/ok=/), a.click('form[action$="/classer"] button')]);
  ok(db.prepare("SELECT COUNT(*) n FROM conversation_reports WHERE conversation_id=? AND status='open'").get(cid).n === 0, 'admin : signalements de conversation classés');
  // utilisateur banni : ne peut plus envoyer
  const pId = db.prepare("SELECT id FROM users WHERE phone='+242069998877'").get().id;
  await a.goto(`${B}/admin/utilisateurs/${pId}`); await a.click('summary:has-text("Bannir")'); await a.fill('form[action$=bannir] input[name=reason]', 'Test messagerie');
  await Promise.all([a.waitForURL(/ok=/), a.click('form[action$=bannir] button')]);
  const before2 = db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id=?').get(cid).n;
  ok((await p.request.post(`${B}/messages/${cid}`, { form: { _csrf: csP, body: 'je suis banni' }, headers: { Accept: 'application/json' } })).status() === 401, 'banni : envoi impossible (session invalidée)');
  const rs = await s.request.post(`${B}/messages/${cid}`, { form: { _csrf: csS, body: 'test' }, headers: { Accept: 'application/json' } });
  ok(rs.status() === 400 && (await rs.json()).error.includes('suspendu'), 'écrire à un compte banni : refusé');
  ok(db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id=?').get(cid).n === before2, 'aucun message enregistré');
  await a.click('form[action$=debannir] button'); await a.waitForURL(/ok=/);
  await a.goto(B + '/admin/moderation'); await a.fill('textarea[name=banned_words]', ''); await Promise.all([a.waitForURL(/ok=/), a.click('form[action="/admin/reglages"] button')]);
  // limite d'envoi
  let limited = false, sent = 0;
  for (let i = 0; i < 40 && !limited; i++) { const r = await s.request.post(`${B}/messages/${cid}`, { form: { _csrf: csS, body: 'Message ' + i }, headers: { Accept: 'application/json' } }); if (r.status() === 429) limited = true; else sent++; }
  ok(limited && sent < 35, `limite d'envoi atteinte après ${sent} messages (30 / 10 min)`);
  await a.goto(B + '/admin/journal'); const jm = await a.textContent('main');
  for (const t of ['Conversation signalée consultée', 'Signalements de conversation classés', 'Message avec mots interdits']) ok(jm.includes(t), `journal : « ${t} »`);
  // ===== Boosts & paiements Mobile Money =====
  const crypto = require('crypto'); const fs = require('fs');
  const SECRET = process.env.SESSION_SECRET || fs.readFileSync(path.join(ROOT, 'data', 'secret.key'), 'utf8').trim();
  const devCallback = (body) => { const raw = JSON.stringify(body); return s.request.post(`${B}/webhooks/dev`, { data: raw, headers: { 'Content-Type': 'application/json', 'x-omoni-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('hex') } }); };
  const txOf = (ref) => db.prepare('SELECT * FROM transactions WHERE ref=?').get(ref);
  const adB = pAds[0]; const adRow = () => db.prepare('SELECT * FROM ads WHERE id=?').get(adB);
  db.prepare('UPDATE ads SET featured_until=NULL, urgent_until=NULL WHERE id=?').run(adB);
  ok((await s.goto(`${B}/annonce/${OTHER}/booster`)).status() === 403, "booster l'annonce d'un autre -> 403");
  ok((await s.request.post(`${B}/annonce/${OTHER}/booster`, { form: { _csrf: csS, product: 'une', operator: 'airtel', phone: '055551234' } })).status() === 403, "POST booster l'annonce d'un autre -> 403");
  await s.goto(B + '/mes-annonces'); ok(await s.isVisible(`#ad-${adB} a.btn-boost`), 'bouton « Booster » dans Mes annonces');
  await s.click(`#ad-${adB} a.btn-boost`); await s.waitForURL(/booster$/);
  ok((await s.textContent('.opts')).includes('2 000 FCFA') && (await s.textContent('.opts')).includes('500 FCFA'), 'choix des options avec prix en FCFA');
  ok(await s.inputValue('input[name=phone]') === '055551234' && await s.isChecked('input[value=airtel]'), 'numéro du compte pré-rempli, opérateur Airtel déduit (05)');
  if (SHOTS) await s.screenshot({ path: D + '13-booster.png', fullPage: true });
  await s.check('input[name=operator][value=mtn]'); await s.click('#paybtn');
  ok((await s.textContent('.notice.bad')).includes('ne correspond pas à MTN'), 'numéro Airtel avec MTN MoMo refusé (préfixe 06 exigé)');
  await s.check('input[name=product][value=une]'); await s.check('input[name=operator][value=airtel]'); await s.fill('input[name=phone]', '05 555 12 34');
  await Promise.all([s.waitForURL(/\/paiements\/[0-9a-f-]{36}$/), s.click('#paybtn')]);
  const ref1 = s.url().split('/').pop();
  ok(txOf(ref1).status === 'pending' && !adRow().featured_until, 'paiement en attente : boost PAS encore activé');
  ok((await s.textContent('.pay-wait')).includes('Confirmez le paiement'), "page d'attente : instructions de confirmation sur le téléphone");
  if (SHOTS) await s.screenshot({ path: D + '14-paiement.png', fullPage: true });
  const st = await (await s.request.get(`${B}/paiements/${ref1}/statut`)).json(); ok(st.status === 'pending', 'statut interrogé : pending');
  ok((await a.request.get(`${B}/paiements/${ref1}/statut`)).status() === 404, "statut du paiement d'un autre : refusé");
  ok((await a.request.post(`${B}/paiements/${ref1}/simuler`, { form: { _csrf: await csrfOf(a), result: 'success' } })).status() === 403, "un autre compte ne peut pas valider le paiement");
  ok((await s.request.post(`${B}/webhooks/dev`, { data: { ref: ref1, status: 'success' } })).status() === 401, 'callback non signé rejeté');
  ok(txOf(ref1).status === 'pending', '… le paiement reste en attente');
  await Promise.all([s.waitForURL(new RegExp(ref1 + '$')), s.click('form[action$=simuler] button.btn:not(.btn-danger)')]);
  ok((await s.textContent('.pay-ok')).includes('boost activé'), 'paiement confirmé -> boost activé, reçu affiché');
  const fu = adRow().featured_until; ok(fu > Date.now() + 6.9 * 86400000, 'À la une : 7 jours');
  const cb1 = await (await devCallback({ ref: ref1, status: 'success' })).json(); const cb2 = await (await devCallback({ ref: ref1, status: 'failed' })).json();
  ok(!cb1.changed && !cb2.changed && txOf(ref1).status === 'success' && adRow().featured_until === fu, 'callbacks rejoués (succès / échec) : sans effet (idempotent)');
  await ap.goto(B + '/'); ok(await ap.isVisible(`#une a[href="/annonce/${adB}"]`), "accueil : annonce dans « À la une »");
  ok((await ap.textContent(`#une .cardw:has(a[href="/annonce/${adB}"])`)).includes('À la une'), 'badge « À la une » sur la carte');
  // échec
  await s.goto(`${B}/annonce/${adB}/booster`); await s.check('input[name=product][value=urgent]');
  await Promise.all([s.waitForURL(/paiements\//), s.click('#paybtn')]); const ref2 = s.url().split('/').pop();
  await Promise.all([s.waitForURL(new RegExp(ref2 + '$')), s.click('form[action$=simuler] button.btn-danger')]);
  ok(txOf(ref2).status === 'failed' && !adRow().urgent_until && (await s.textContent('.notice.bad')).includes('échoué'), 'paiement refusé -> échec affiché, aucun boost');
  // expiration
  await s.goto(`${B}/annonce/${adB}/booster`); await s.check('input[name=product][value=remonter]');
  await Promise.all([s.waitForURL(/paiements\//), s.click('#paybtn')]); const ref3 = s.url().split('/').pop();
  const created3 = adRow().created_at;
  db.prepare('UPDATE transactions SET expires_at = ? WHERE ref = ?').run(Date.now() - 1000, ref3);
  ok((await (await s.request.get(`${B}/paiements/${ref3}/statut`)).json()).status === 'expired', 'paiement non confirmé après 10 min -> expiré');
  await s.request.post(`${B}/paiements/${ref3}/simuler`, { form: { _csrf: csS, result: 'success' } });
  ok(txOf(ref3).status === 'expired' && adRow().created_at === created3, 'simulation après expiration : sans effet');
  // urgent réussi par callback signé + expiration du badge
  await s.goto(`${B}/annonce/${adB}/booster`); await s.check('input[name=product][value=urgent]');
  await Promise.all([s.waitForURL(/paiements\//), s.click('#paybtn')]); const ref4 = s.url().split('/').pop();
  ok((await (await devCallback({ ref: ref4, status: 'success' })).json()).changed, 'callback signé : paiement confirmé');
  await s.waitForURL(new RegExp(ref4 + '$')); await s.waitForSelector('.pay-ok', { timeout: 8000 }); ok(true, "page d'attente mise à jour automatiquement après confirmation");
  await ap.goto(`${B}/annonce/${adB}`); ok((await ap.textContent('.info')).includes('Urgent'), 'badge « Urgent » sur la page annonce');
  db.prepare('UPDATE ads SET urgent_until = ? WHERE id = ?').run(Date.now() - 1000, adB);
  await ap.goto(`${B}/annonce/${adB}`); ok(!(await ap.textContent('.info')).includes('🔥 Urgent'), 'badge « Urgent » disparaît à expiration');
  await s.goto(B + '/mes-paiements'); const mp = await s.textContent('main');
  ok(['Payé', 'Échoué', 'Expiré'].every((t) => mp.includes(t)), 'Mes paiements : reçus avec statuts');
  // admin : liste, recettes, remboursement, tarifs
  ok((await p.request.get(`${B}/admin/paiements`, { maxRedirects: 0 })).status() !== 200, 'non-admin : /admin/paiements inaccessible');
  await a.goto(B + '/admin'); ok((await a.textContent('.stats')).includes('3 000 FCFA'), 'tableau de bord : recettes (2 000 + 1 000 FCFA)');
  await a.goto(`${B}/admin/paiements?q=${ref1}`); ok(await a.locator('.logrow').count() === 1, 'admin : recherche par référence');
  await a.click('summary:has-text("Marquer remboursé")'); await a.fill('form[action$=rembourser] input[name=reason]', 'Test e2e');
  await Promise.all([a.waitForURL(/ok=/), a.click('form[action$=rembourser] button')]);
  ok(txOf(ref1).status === 'refunded' && adRow().featured_until <= Date.now() + 1000, 'remboursement marqué -> boost « À la une » retiré');
  await ap.goto(B + '/'); ok(!(await ap.isVisible(`#une a[href="/annonce/${adB}"]`)), "badge / section « À la une » disparus");
  await a.goto(B + '/admin/boosts'); await a.fill('input[name=price_urgent]', '1500');
  await Promise.all([a.waitForURL(/ok=/), a.click('form[action="/admin/boosts"] button')]);
  await s.goto(`${B}/annonce/${adB}/booster`); ok((await s.textContent('.opts')).includes('1 500 FCFA'), 'nouveau tarif appliqué');
  await a.goto(B + '/admin/journal'); const jp = await a.textContent('main');
  for (const t of ['Paiement confirmé', 'Paiement marqué remboursé', 'Tarifs des boosts modifiés']) ok(jp.includes(t), `journal : « ${t} »`);
  // déconnexion
  await s.click('details.menu summary'); await Promise.all([s.waitForURL(B + '/'), s.click('.menu-pop button')]);
  ok(await s.isVisible('a.login-link'), 'déconnexion OK');
  ok((await s.goto(B + '/mes-annonces')).url().includes('/connexion'), 'Mes annonces exige la connexion');
  await br.close();
  console.log('TOUS LES TESTS PASSENT');
})().catch((e) => { console.error(e.message); process.exit(1); });
