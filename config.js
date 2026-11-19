// Configuration modifiable : nom de marque, villes, catégories
module.exports = {
  BRAND: 'OMONI',            // nom de marque choisi par Franck — modifiable ici
  TAGLINE: 'Le marché des petites annonces au Congo',
  CITIES: ['Brazzaville', 'Pointe-Noire', 'Dolisie', 'Nkayi', 'Owando', 'Ouesso', 'Impfondo',
    'Madingou', 'Sibiti', 'Oyo', 'Djambala', 'Kinkala', 'Autre'],
  CATEGORIES: [
    { slug: 'vehicules', name: 'Véhicules', icon: '🚗' },
    { slug: 'immobilier', name: 'Immobilier', icon: '🏠' },
    { slug: 'electronique', name: 'Électronique & Téléphones', icon: '📱' },
    { slug: 'maison', name: 'Maison & Meubles', icon: '🛋️' },
    { slug: 'mode', name: 'Mode & Beauté', icon: '👗' },
    { slug: 'emploi', name: 'Emploi', icon: '💼' },
    { slug: 'services', name: 'Services', icon: '🛠️' },
    { slug: 'agriculture', name: 'Agriculture & Élevage', icon: '🌱' },
    { slug: 'autres', name: 'Autres', icon: '📦' },
  ],
  REPORT_HIDE_THRESHOLD: 3, // annonce masquée automatiquement après N signalements
  MAX_PHOTOS: 6,
  MSG_MAX_LENGTH: 1000,
  MSG_RATE_10MIN: Number(process.env.MSG_RATE_10MIN) || 30,  // messages max par utilisateur / 10 min
  CONV_RATE_DAY: Number(process.env.CONV_RATE_DAY) || 20,    // nouvelles conversations max par utilisateur / 24 h
  FEATURED_SLOTS_HOME: 4,   // annonces « À la une » affichées sur l'accueil (rotation aléatoire)
  FEATURED_SLOTS_LIST: 3,   // annonces « À la une » épinglées en haut des résultats
  PAYMENT_TTL_MIN: 10,      // une demande de paiement non confirmée expire après N minutes
  AD_TTL_DAYS: 60, // durée de vie d'une annonce avant expiration (renouvelable)
};
