// Envoi WhatsApp — fournisseur choisi par WHATSAPP_PROVIDER.
//   dev (défaut) : aucun envoi réel ; l'alerte est écrite dans les logs (et visible dans Admin › Alertes envoyées).
//   meta         : WhatsApp Business Cloud API (Meta). Variables :
//                  WHATSAPP_TOKEN (jeton d'accès permanent d'un « utilisateur système »), WHATSAPP_PHONE_NUMBER_ID,
//                  WHATSAPP_TEMPLATE (nom du modèle approuvé, défaut « nouveau_message »), WHATSAPP_TEMPLATE_LANG (défaut « fr »),
//                  WHATSAPP_API_VERSION (défaut v21.0).
//   Hors fenêtre de 24 h ouverte par l'utilisateur, WhatsApp n'autorise QUE des messages « modèle » (template) pré-approuvés.
//   Modèle attendu (catégorie « Utility », langue fr), 3 variables :
//     « OMONI : nouveau message de {{1}} à propos de « {{2}} ». Répondez : {{3}} »
// Interface : async send(toE164, { text, params: [nom, titre, lien] }) -> { ok: true, id? } (lève une erreur sinon).
// ⚠ Le fournisseur « meta » suit la documentation publique de Meta mais n'a PAS été testé.
const providers = {
  dev: {
    async send(to, { text }) { console.log(`[WhatsApp dev] -> ${to} : ${text}`); return { ok: true }; },
  },
  meta: {
    async send(to, { params }) {
      const e = process.env; const v = e.WHATSAPP_API_VERSION || 'v21.0';
      const r = await fetch(`https://graph.facebook.com/${v}/${e.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + e.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'template',
          template: { name: e.WHATSAPP_TEMPLATE || 'nouveau_message', language: { code: e.WHATSAPP_TEMPLATE_LANG || 'fr' },
            components: [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t) })) }] },
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('WhatsApp ' + r.status + ' ' + (j.error?.message || ''));
      return { ok: true, id: j.messages?.[0]?.id };
    },
  },
};
const NAME = process.env.WHATSAPP_PROVIDER || 'dev';
if (!providers[NAME]) throw new Error(`WHATSAPP_PROVIDER inconnu : ${NAME}`);
module.exports = { name: NAME, isDev: NAME === 'dev', send: (to, msg) => providers[NAME].send(to, msg) };
