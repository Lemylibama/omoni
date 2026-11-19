// Quartiers / arrondissements par ville — liste volontairement courte et vérifiée (Wikipédia FR : pages Brazzaville,
// arrondissements de Brazzaville, Pointe-Noire, Nkayi ; Wikipédia EN : Dolisie ; adiac-congo.com : Owando, Ouesso ;
// recensement RGPH-5 via ecolesaucongo.com : Ouesso). Chaque ville reçoit l'option « Autre quartier ».
// Groupes = [libellé du groupe, [noms]] ; la valeur stockée en base est le nom (ads.quartier).
const OTHER = 'Autre quartier';
const DATA = {
  Brazzaville: [
    ['1 · Makélékélé', ['Makélékélé', 'Diata', 'Kinsoundi', 'Kingouari']],
    ['2 · Bacongo', ['Bacongo', 'La Glacière', 'Dahomey', 'Mpissa', 'Tahiti']],
    ['3 · Poto-Poto', ['Poto-Poto']],
    ['4 · Moungali', ['Moungali', 'Plateau des 15 ans', 'Moukondo', 'OCH']],
    ['5 · Ouenzé', ['Ouenzé']],
    ['6 · Talangaï', ['Talangaï', 'Mpila', 'Texaco La Tsiémé', 'Ngamakosso']],
    ['7 · Mfilou', ['Mfilou']],
    ['8 · Madibou', ['Madibou', 'Kombé']],
    ['9 · Djiri', ['Djiri', 'Mikalou', 'Nkombo', 'Makabandilou']],
    ['Centre et environs', ['Centre-ville', 'Plateau', 'La Plaine', 'Kintélé']],
  ],
  'Pointe-Noire': [
    ['Arrondissements', ['Lumumba', 'Mvou-Mvou', 'Tié-Tié', 'Loandjili', 'Mongo-Mpoukou', 'Ngoyo']],
    ['Quartiers', ['Centre-ville', 'Côte sauvage', 'Matendé', 'Mawata', 'Mbota', 'Makaya-Makaya', 'Nkouikou', 'OCH', 'Siafoumou', 'Tchimbamba', 'Planches']],
  ],
  Dolisie: [['Arrondissements', ['Foundou-Foundou', 'Youlou-Poungui']], ['Quartiers', ['Mangadzi']]],
  Nkayi: [['Arrondissements', ['Mouana-Nto', 'Soulouka']]],
  Owando: [['Quartiers', ['Onkindodzoko', 'Oloko']]],
  Ouesso: [['Arrondissements', ['Nzalangoye', 'Mbindjo']], ['Quartiers', ['Mboma', 'Ngongo', 'Mayimpouma']]],
};
const groupsFor = (city) => [...(DATA[city] || []), ['', [OTHER]]];
const namesFor = (city) => groupsFor(city).flatMap(([, n]) => n);
const isValid = (city, q) => !q || namesFor(city).includes(q);
const ALL = [...new Set(Object.keys(DATA).flatMap(namesFor).concat(OTHER))];
// « Poto-Poto, Brazzaville » ; « Autre quartier » n'est pas affiché
const place = (ad) => (ad.quartier && ad.quartier !== OTHER ? `${ad.quartier}, ${ad.city}` : ad.city);
module.exports = { DATA, OTHER, groupsFor, namesFor, isValid, ALL, place };
