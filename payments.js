// Paiements Mobile Money — abstraction des fournisseurs.
//
// PAYMENT_PROVIDER=dev (défaut) : paiements SIMULÉS (bandeau « Mode test », boutons Réussite / Échec).
// PAYMENT_PROVIDER=live         : vrais paiements ; chaque opérateur est actif si ses identifiants sont configurés :
//   MTN MoMo (Open API « Collections ») : MTN_BASE_URL, MTN_SUBSCRIPTION_KEY, MTN_API_USER, MTN_API_KEY,
//        MTN_TARGET_ENV (sandbox | mtncongo), MTN_CURRENCY (XAF ; le bac à sable n'accepte que EUR)
//   Airtel Money (Airtel Africa Open API « Collection ») : AIRTEL_BASE_URL, AIRTEL_CLIENT_ID, AIRTEL_CLIENT_SECRET,
//        AIRTEL_COUNTRY (CG), AIRTEL_CURRENCY (XAF), AIRTEL_CALLBACK_SECRET (facultatif)
//   PUBLIC_BASE_URL : URL publique HTTPS du site, pour les callbacks (ex. https://omoni.cg)
// Agrégateur (non implémenté) : un fournisseur comme CinetPay, PayDunya ou Flutterwave peut remplacer les deux
// intégrations directes (un seul contrat, une seule API) : ajouter un objet { requestToPay, getStatus } ci-dessous.
//
// ⚠ Les fournisseurs « mtn » et « airtel » suivent la documentation publique mais n'ont PAS été testés.
// Interface commune :
//   requestToPay(tx) -> { providerRef? }                       (lève une erreur si la demande est refusée)
//   getStatus(tx)    -> { status: 'pending'|'success'|'failed', providerRef?, reason? }
const crypto = require('crypto');

const MODE = process.env.PAYMENT_PROVIDER || 'dev';
const env = process.env;

// --- MTN MoMo ---
let mtnToken = null;
async function mtnAuth() {
  if (mtnToken && mtnToken.exp > Date.now() + 60000) return mtnToken.value;
  const r = await fetch(`${env.MTN_BASE_URL}/collection/token/`, { method: 'POST', headers: {
    Authorization: 'Basic ' + Buffer.from(`${env.MTN_API_USER}:${env.MTN_API_KEY}`).toString('base64'), 'Ocp-Apim-Subscription-Key': env.MTN_SUBSCRIPTION_KEY } });
  if (!r.ok) throw new Error('MTN token ' + r.status);
  const j = await r.json(); mtnToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; return mtnToken.value;
}
const mtnHeaders = async () => ({ Authorization: 'Bearer ' + (await mtnAuth()), 'X-Target-Environment': env.MTN_TARGET_ENV || 'sandbox', 'Ocp-Apim-Subscription-Key': env.MTN_SUBSCRIPTION_KEY });
const mtn = {
  configured: () => !!(env.MTN_BASE_URL && env.MTN_SUBSCRIPTION_KEY && env.MTN_API_USER && env.MTN_API_KEY),
  async requestToPay(tx, callbackUrl) {
    const headers = { ...(await mtnHeaders()), 'X-Reference-Id': tx.ref, 'Content-Type': 'application/json' };
    if (callbackUrl) headers['X-Callback-Url'] = callbackUrl;
    const r = await fetch(`${env.MTN_BASE_URL}/collection/v1_0/requesttopay`, { method: 'POST', headers, body: JSON.stringify({
      amount: String(tx.amount), currency: env.MTN_CURRENCY || 'XAF', externalId: tx.ref,
      payer: { partyIdType: 'MSISDN', partyId: tx.payer_phone.replace('+', '') }, // ex. 242061234567
      payerMessage: `OMONI ${tx.product_name}`.slice(0, 160), payeeNote: `Annonce ${tx.ad_id}` }) });
    if (r.status !== 202) throw new Error('MTN requesttopay ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return {};
  },
  async getStatus(tx) {
    const r = await fetch(`${env.MTN_BASE_URL}/collection/v1_0/requesttopay/${tx.ref}`, { headers: await mtnHeaders() });
    if (!r.ok) throw new Error('MTN status ' + r.status);
    const j = await r.json(); // { status: PENDING|SUCCESSFUL|FAILED, financialTransactionId, reason }
    return { status: j.status === 'SUCCESSFUL' ? 'success' : j.status === 'FAILED' ? 'failed' : 'pending', providerRef: j.financialTransactionId, reason: j.reason && (j.reason.message || j.reason.code || String(j.reason)) };
  },
};

// --- Airtel Money ---
let airtelToken = null;
async function airtelAuth() {
  if (airtelToken && airtelToken.exp > Date.now() + 60000) return airtelToken.value;
  const r = await fetch(`${env.AIRTEL_BASE_URL}/auth/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: '*/*' },
    body: JSON.stringify({ client_id: env.AIRTEL_CLIENT_ID, client_secret: env.AIRTEL_CLIENT_SECRET, grant_type: 'client_credentials' }) });
  if (!r.ok) throw new Error('Airtel token ' + r.status);
  const j = await r.json(); airtelToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 180) * 1000 }; return airtelToken.value;
}
const airtelHeaders = async () => ({ Authorization: 'Bearer ' + (await airtelAuth()), 'Content-Type': 'application/json', Accept: '*/*', 'X-Country': env.AIRTEL_COUNTRY || 'CG', 'X-Currency': env.AIRTEL_CURRENCY || 'XAF' });
const airtel = {
  configured: () => !!(env.AIRTEL_BASE_URL && env.AIRTEL_CLIENT_ID && env.AIRTEL_CLIENT_SECRET),
  async requestToPay(tx) {
    // Le callback est configuré une fois pour toutes dans le portail Airtel (pas par requête).
    // NB : selon le pays / la version de l'API, Airtel peut exiger le chiffrement du message (en-têtes x-signature / x-key) : à vérifier à l'intégration.
    const r = await fetch(`${env.AIRTEL_BASE_URL}/merchant/v1/payments/`, { method: 'POST', headers: await airtelHeaders(), body: JSON.stringify({
      reference: `OMONI ${tx.product_name}`.slice(0, 64),
      subscriber: { country: env.AIRTEL_COUNTRY || 'CG', currency: env.AIRTEL_CURRENCY || 'XAF', msisdn: tx.payer_phone.replace(/^\+242/, '') }, // sans indicatif pays
      transaction: { amount: tx.amount, country: env.AIRTEL_COUNTRY || 'CG', currency: env.AIRTEL_CURRENCY || 'XAF', id: tx.ref } }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.status?.success === false) throw new Error('Airtel payments ' + r.status + ' ' + JSON.stringify(j?.status || {}).slice(0, 200));
    return {};
  },
  async getStatus(tx) {
    const r = await fetch(`${env.AIRTEL_BASE_URL}/standard/v1/payments/${tx.ref}`, { headers: await airtelHeaders() });
    if (!r.ok) throw new Error('Airtel status ' + r.status);
    const t = (await r.json())?.data?.transaction || {}; // status : TS (succès) | TF (échec) | TA / TIP (en cours)
    return { status: t.status === 'TS' ? 'success' : t.status === 'TF' ? 'failed' : 'pending', providerRef: t.airtel_money_id, reason: t.message };
  },
  // Vérification facultative du callback authentifié Airtel (HMAC-SHA256 du corps avec la clé secrète)
  verifyCallback(raw, headers) {
    if (!env.AIRTEL_CALLBACK_SECRET) return null; // non configuré : on se fie uniquement à la re-vérification du statut
    const sig = headers['x-signature'] || headers['x-hash'] || '';
    const exp = crypto.createHmac('sha256', env.AIRTEL_CALLBACK_SECRET).update(raw).digest('base64');
    return sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
  },
};

// --- Simulation (développement / démonstration) ---
const dev = {
  configured: () => true,
  async requestToPay() { return { providerRef: 'SIM-' + crypto.randomBytes(5).toString('hex').toUpperCase() }; },
  async getStatus(tx) { return { status: tx.sim_result || 'pending' }; }, // le résultat est fixé par les boutons de simulation
};

const OPERATORS = {
  mtn: { code: 'mtn', name: 'MTN MoMo', prefixes: ['06'], hint: 'Numéro MTN commençant par 06', ussd: 'Validez avec votre code secret MoMo (ou composez *105# puis « Approbations » si la demande ne s\'affiche pas).' },
  airtel: { code: 'airtel', name: 'Airtel Money', prefixes: ['05', '04'], hint: 'Numéro Airtel commençant par 05 ou 04', ussd: 'Validez avec votre code PIN Airtel Money (ou composez *128# puis « Mes approbations » si la demande ne s\'affiche pas).' },
};
const providerFor = (op) => (MODE === 'dev' ? dev : op === 'mtn' ? mtn : airtel);
const enabledOperators = () => Object.values(OPERATORS).filter((o) => MODE === 'dev' || providerFor(o.code).configured());

module.exports = { MODE, isDev: MODE === 'dev', OPERATORS, enabledOperators, providerFor, mtn, airtel, dev, newRef: () => crypto.randomUUID() };
