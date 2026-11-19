// Conversations d'EXEMPLE entre comptes de démo (recréées à chaque appel)
const MIN = 60000;
const CONVS = [
  { ad: 1, buyer: '+242066543210', msgs: [ // Toyota Corolla (Jean-Claude) <- Mireille
    ['b', 'EXEMPLE — Bonjour, la Corolla est toujours disponible ? Elle a déjà eu des accidents ?', 300],
    ['s', "Bonjour Madame, oui elle est disponible. Aucun accident, carnet d'entretien à jour.", 280],
    ['b', 'Je peux la voir samedi matin à Moungali ? Mon dernier prix serait 4 200 000.', 60],
    ['s', 'Samedi 9 h devant la station Total de Moungali, ça vous va ? Pour le prix on en parle sur place. Mon WhatsApp : 06 123 45 67', 20],
    ['b', 'Parfait, à samedi !', 5],
  ], sellerRead: 4 },
  { ad: 2, buyer: '+242061234567', msgs: [ // Moto Haojue (Prince) <- Jean-Claude
    ['b', 'EXEMPLE — Bonsoir, la moto a combien de kilomètres ?', 900],
    ['s', 'Bonsoir, 3 200 km seulement. Elle est à Tié-Tié.', 870],
  ], buyerRead: 1 },
  { ad: 7, buyer: '+242055551234', msgs: [ // iPhone 12 (Mireille) <- Prince
    ['b', "EXEMPLE — Bonjour, l'iPhone est débloqué tous opérateurs ?", 1500],
    ['s', 'Oui, il marche avec MTN et Airtel. Batterie 86 %.', 1450],
    ['b', "D'accord merci, je réfléchis.", 1440],
  ] },
];
module.exports = function seedConversations(db) {
  db.exec('DELETE FROM conversations WHERE is_example = 1');
  const ads = db.prepare('SELECT * FROM ads WHERE is_example = 1 ORDER BY id').all();
  const uid = (phone) => db.prepare('SELECT id FROM users WHERE phone = ?').get(phone)?.id;
  let n = 0;
  for (const cv of CONVS) {
    const ad = ads[cv.ad - 1]; const buyer = uid(cv.buyer);
    if (!ad || !buyer || !ad.user_id || ad.user_id === buyer) continue;
    const t0 = Date.now() - cv.msgs[0][2] * MIN;
    const cid = db.prepare('INSERT INTO conversations (ad_id, ad_title, buyer_id, seller_id, is_example, created_at, last_message_at) VALUES (?,?,?,?,1,?,?)')
      .run(ad.id, ad.title, buyer, ad.user_id, t0, Date.now() - cv.msgs[cv.msgs.length - 1][2] * MIN).lastInsertRowid;
    const ids = cv.msgs.map(([who, body, ago]) => db.prepare('INSERT INTO messages (conversation_id, sender_id, body, is_example, created_at) VALUES (?,?,?,1,?)')
      .run(cid, who === 'b' ? buyer : ad.user_id, body, Date.now() - ago * MIN).lastInsertRowid);
    // état « lu » : par défaut tout est lu, sauf indication (pour montrer des badges non lus)
    const last = ids[ids.length - 1];
    db.prepare('UPDATE conversations SET buyer_last_read = ?, seller_last_read = ? WHERE id = ?')
      .run(cv.buyerRead ? ids[cv.buyerRead - 1] : last, cv.sellerRead ? ids[cv.sellerRead - 1] : last, cid);
    n++;
  }
  return n;
};
