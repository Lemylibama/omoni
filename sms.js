// Envoi de SMS — fournisseur choisi par la variable d'environnement SMS_PROVIDER.
//   dev (défaut)      : aucun SMS réel ; le code est écrit dans les logs et affiché à l'écran (« Mode test »).
//   twilio            : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (numéro ou Sender ID alphanumérique)
//   africastalking    : AT_USERNAME, AT_API_KEY, AT_SENDER_ID (facultatif)
//   http              : passerelle locale / agrégateur (ex. via un opérateur MTN / Airtel Congo) :
//                       SMS_HTTP_URL (POST JSON {to, message}), SMS_HTTP_TOKEN (Bearer, facultatif)
// Chaque fournisseur expose : async send(toE164, message) -> { ok: true } (lève une erreur sinon).
// NB : les fournisseurs réels sont implémentés d'après leurs API publiques mais n'ont PAS été testés.

const devOutbox = new Map(); // dernier code par numéro (mode dev uniquement)

const providers = {
  dev: {
    async send(to, message) {
      console.log(`[SMS dev] -> ${to} : ${message}`);
      devOutbox.set(to, message);
      return { ok: true };
    },
  },
  twilio: {
    async send(to, message) {
      const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok, TWILIO_FROM: from } = process.env;
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: from, Body: message }),
      });
      if (!r.ok) throw new Error('Twilio ' + r.status + ' ' + (await r.text()));
      return { ok: true };
    },
  },
  africastalking: {
    async send(to, message) {
      const { AT_USERNAME: username, AT_API_KEY: apiKey, AT_SENDER_ID: from } = process.env;
      const host = username === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
      const body = new URLSearchParams({ username, to, message }); if (from) body.set('from', from);
      const r = await fetch(`https://${host}/version1/messaging`, { method: 'POST', headers: { apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (!r.ok) throw new Error('AfricasTalking ' + r.status + ' ' + (await r.text()));
      return { ok: true };
    },
  },
  http: {
    async send(to, message) {
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.SMS_HTTP_TOKEN) headers.Authorization = 'Bearer ' + process.env.SMS_HTTP_TOKEN;
      const r = await fetch(process.env.SMS_HTTP_URL, { method: 'POST', headers, body: JSON.stringify({ to, message }) });
      if (!r.ok) throw new Error('Passerelle SMS ' + r.status);
      return { ok: true };
    },
  },
};

const NAME = process.env.SMS_PROVIDER || 'dev';
if (!providers[NAME]) throw new Error(`SMS_PROVIDER inconnu : ${NAME}`);
module.exports = {
  name: NAME,
  isDev: NAME === 'dev',
  send: (to, message) => providers[NAME].send(to, message),
  devOutbox,
};
