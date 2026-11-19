# OMONI — petites annonces pour la République du Congo (prototype)

« OMONI » est le nom de marque du site ; il se change dans `config.js` (`BRAND`).

Site de petites annonces façon leboncoin / Gumtree, 100 % en français, pensé mobile d'abord et connexions lentes
(HTML rendu côté serveur, aucun framework JS, ~9 Ko de CSS, images compressées et chargées en différé).

## Lancer
```bash
npm install
npm run seed      # ~22 annonces d'exemple rattachées à 4 comptes vendeurs de démo (`npm run seed:reset` pour recréer)
npm start         # http://localhost:3000
```
Prérequis : **Node.js ≥ 22.5** (module intégré `node:sqlite`).

### Variables d'environnement
| Variable | Rôle |
|---|---|
| `PORT` | port HTTP (3000 par défaut) |
| `SESSION_SECRET` | secret de signature des cookies (sinon généré une fois dans `data/secret.key`) |
| `SMS_PROVIDER` | `dev` (défaut), `twilio`, `africastalking` ou `http` — voir `sms.js` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | si `SMS_PROVIDER=twilio` |
| `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID` | si `SMS_PROVIDER=africastalking` (`AT_USERNAME=sandbox` pour le bac à sable) |
| `SMS_HTTP_URL`, `SMS_HTTP_TOKEN` | si `SMS_PROVIDER=http` (passerelle locale : POST JSON `{to, message}`) |
| `MSG_RATE_10MIN`, `CONV_RATE_DAY` | limites de la messagerie : messages / 10 min (30) et nouvelles conversations / 24 h (20) par utilisateur |
| `ADMIN_PHONES` | numéros promus administrateurs au démarrage, séparés par des virgules (ex. `+242060000001,+242069998877`) |

En **mode test** (`SMS_PROVIDER=dev`), aucun SMS n'est envoyé : le code s'affiche à l'écran avec un bandeau « Mode test » et dans les logs du serveur.

**Comptes de démo** : vendeurs +242 06 123 45 67, 05 555 12 34, 06 654 32 10, 06 876 54 32 ;
**administrateur de démo : +242 06 000 00 01** (connexion par code comme n'importe quel compte, puis menu → 🛡 Administration ou `/admin`).

> ⚠ En mode test, le code s'affiche à l'écran : **n'importe qui peut se connecter à n'importe quel compte, y compris administrateur**.
> Ne jamais exposer le site publiquement avec `SMS_PROVIDER=dev`, et supprimer / rétrograder le compte admin de démo en production
> (`npm run admin -- demote 060000001`).

## Pile technique
- Node.js + Express, rendu HTML côté serveur (gabarits JS dans `server.js`)
- SQLite (`node:sqlite`) — `data/annonces.db` ; photos sur disque dans `uploads/` (Multer)
- `auth.js` : codes OTP, sessions, CSRF · `sms.js` : fournisseurs SMS interchangeables
- JS client minimal : `public/post.js` (aperçu + redimensionnement des photos dans le navigateur, 1280 px / JPEG 80 %),
  `public/app.js` (favoris sans rechargement, menu compte), `public/chat.js` (messagerie). Tout fonctionne aussi sans JS.

## Fonctionnalités
- Accueil, liste avec filtres (catégorie, ville, prix, mot-clé) + tri + pagination, page annonce avec **Appeler** / **WhatsApp** (+242, message pré-rempli), **Signaler**
- **Connexion par SMS** (`/connexion`) : numéro mobile congolais (04/05/06, 9 chiffres, stocké en +242… ; les fixes 22 ne reçoivent pas de SMS), code à 6 chiffres
  haché (HMAC) en base, valable 10 min, 5 essais max, un seul code actif ; limites d'envoi : 3 / 10 min et 10 / jour par numéro, 15 / h par IP.
  Compte créé automatiquement à la première connexion.
- **Sessions** : cookie `sid` signé, `HttpOnly`, `SameSite=Lax`, `Secure` derrière HTTPS, 30 jours ; jeton haché en base ; déconnexion.
- **CSRF** : jeton dérivé d'un cookie signé, vérifié sur tous les formulaires POST (y compris envoi de photos).
- **Mes annonces** : Modifier (tous les champs + ajout/retrait de photos), Supprimer (page de confirmation), Renouveler (remonte en tête, +60 jours),
  Marquer comme vendu / Remettre en vente ; date d'expiration affichée. Les annonces expirent après 60 jours (`AD_TTL_DAYS`) et sont alors masquées au public.
- Déposer une annonce exige d'être connecté (redirection vers la connexion puis retour au formulaire) ; nom et téléphone pré-remplis depuis le compte.
- **Favoris** (♡ sur les cartes et la page annonce, page **Mes favoris**).
- Contrôle de propriété : on ne peut modifier / supprimer / renouveler que ses propres annonces (403 sinon).
- Signalements : annonce masquée automatiquement après 3 signalements ouverts d'IP différentes (journalisé).
- **Boosts payants** (À la une, Urgent, Remonter en tête) réglés par **MTN MoMo / Airtel Money** : voir plus bas.

## Messagerie (`/messages`)
- Bouton **Envoyer un message** sur les annonces en ligne (connexion requise, retour automatique au message après connexion) ; absent pour le
  propriétaire et sur les annonces vendues / masquées / expirées — les conversations existantes restent lisibles.
- **Une conversation par (annonce, acheteur)** ; le titre de l'annonce est conservé si elle est supprimée.
- **Messages** : liste des conversations (vignette, titre, prix, interlocuteur, aperçu du dernier message, heure, badge non lus, étiquette Vente / Achat) ;
  page de conversation en bulles avec horodatage. Envoi et **actualisation automatique toutes les 10 s** via `public/chat.js` (~2 Ko, uniquement quand la page est visible) ;
  sans JS : formulaire classique + rechargement.
- **Badge de non-lus** dans l'en-tête (💬) et dans le menu du compte.
- Texte seul, 1 000 caractères max, numéros de téléphone autorisés ; CSRF ; seuls les deux participants peuvent lire / écrire (403 sinon) ;
  limites : 30 messages / 10 min et 20 nouvelles conversations / 24 h par utilisateur.
- **Sécurité** : bandeau contre les arnaques au paiement d'avance (Mobile Money) ; **Bloquer** / Débloquer (la personne bloquée ne peut plus vous écrire
  ni vous contacter sur une autre annonce) ; **Signaler la conversation** (file de modération) ; les comptes bannis ne peuvent plus envoyer et ne
  peuvent plus recevoir ; filtre de **mots interdits** : en mode « en attente » le message part mais la conversation est signalée automatiquement,
  en mode « refuser » le message est bloqué.
- Le vendeur voit le nom affiché de l'acheteur, pas son numéro.
- 3 conversations d'**EXEMPLE** entre comptes de démo (`seed/conversations.js`) — ex. connectez-vous avec +242 06 123 45 67.

## Administration / modération (`/admin`)
Accès réservé aux comptes ayant le rôle `admin` (connexion par SMS habituelle). Toutes les routes `/admin` exigent ce rôle (403 sinon)
et un jeton CSRF sur chaque action. L'ancien accès `/admin/signalements?key=…` (`ADMIN_KEY`) a été **supprimé**.

Donner / retirer le rôle : variable `ADMIN_PHONES` (au démarrage) ou en ligne de commande :
```bash
npm run admin -- promote 06 000 00 01
npm run admin -- demote +242060000001
npm run admin -- list
```
- **Tableau de bord** : annonces en ligne, nouvelles du jour / 7 jours, utilisateurs, signalements ouverts, annonces à valider, masquées, utilisateurs bannis ; répartition par catégorie et par ville.
- **Signalements** : file regroupée par annonce (motifs, précisions, nombre) ; actions *Classer sans suite*, *Masquer* (motif affiché au vendeur), *Supprimer*, *Bannir le vendeur* ; historique des signalements traités.
- **Annonces** : recherche dans toutes les annonces (mot-clé, catégorie, ville, statut : en ligne / expirée / vendue / masquée / en attente / refusée, téléphone du vendeur) ; *Voir* (l'admin voit aussi les annonces masquées), *Masquer*, *Rétablir*, *Supprimer*.
- **À valider** : pré-modération optionnelle (réglage) — les nouvelles annonces restent « en attente » jusqu'à *Approuver* / *Refuser* (motif affiché dans « Mes annonces »). Une annonce refusée modifiée par le vendeur repasse en attente.
- **Mots interdits** : liste modifiable (insensible aux accents et majuscules, mots entiers) ; une annonce qui en contient, au dépôt ou à la modification, est mise en attente ou refusée automatiquement (au choix).
- **Utilisateurs** : recherche par téléphone ou nom, fiche avec annonces, signalements reçus et envoyés ; *Bannir* (motif) / *Lever le bannissement*. Un compte banni est déconnecté, ne peut plus se connecter ni publier, et ses annonces sont masquées (réapparaissent s'il est débanni). Les administrateurs ne peuvent pas être bannis depuis le panneau.
- **Conversations signalées** (dans *Signalements*) : par respect de la vie privée, **seules les conversations signalées** (par un participant ou par le filtre de mots interdits)
  peuvent être lues par la modération, et chaque lecture est inscrite au journal ; actions *Classer sans suite*, *Bannir l'acheteur / le vendeur*, *Supprimer la conversation*.
- **Journal** : chaque action (qui, quoi, quand, détails), y compris les actions automatiques (masquage après 3 signalements, mots interdits).
- Renouvellement d'annonce limité à **une fois par 24 h** (sauf annonce expirée).

## Boosts payants & Mobile Money (MTN MoMo, Airtel Money)

**Options** (tarifs modifiables par l'admin dans `/admin/boosts`) :

| Option | Prix par défaut | Effet |
|---|---|---|
| ⬆️ Remonter en tête | **500 FCFA** (une fois) | l'annonce repasse en tête des annonces récentes |
| ⭐ À la une | **2 000 FCFA** / 7 jours | badge « À la une » ; section épinglée en haut de l'accueil (4 places) et en haut des résultats (3 places, page 1, tri récent). L'ordre est tiré au hasard à chaque affichage pour un partage équitable |
| 🔥 Urgent | **1 000 FCFA** / 7 jours | badge rouge « Urgent » sur la carte et sur la page de l'annonce |

Un nouvel achat du même boost prolonge la durée en cours. Les badges disparaissent d'eux-mêmes à la date de fin.

**Parcours** : bouton 🚀 **Booster** (dans Mes annonces ou sur sa propre annonce) → choix de l'option → **MTN MoMo** ou **Airtel Money** →
numéro payeur (+242, pré-rempli avec celui du compte ; MTN = 06…, Airtel = 05… / 04…) → demande de paiement envoyée au téléphone (USSD) →
page d'attente avec actualisation toutes les 4 s → reçu ou échec (avec « Réessayer »). **Le boost n'est activé qu'après la confirmation du paiement.**
Les reçus se trouvent dans 💳 **Mes paiements** (`/mes-paiements`).

**Sécurité / fiabilité** :
- Chaque transaction a une référence UUID, utilisée comme `X-Reference-Id` pour MTN et comme `transaction.id` pour Airtel. Les états possibles sont `pending`, `success`, `failed`, `expired` et `refunded`.
- La finalisation est **idempotente** : elle se fait dans une transaction SQLite, un statut final ne change plus et le boost n'est jamais appliqué deux fois. Un callback rejoué n'a donc aucun effet.
- On ne fait **jamais confiance au client ni au contenu d'un callback**. Un callback ne fait que déclencher une nouvelle vérification du statut auprès de l'opérateur.
  - L'URL de callback MTN contient un jeton HMAC.
  - Le callback Airtel est vérifié par signature HMAC si `AIRTEL_CALLBACK_SECRET` est défini.
  - Le webhook de test `/webhooks/dev` exige l'en-tête `x-omoni-signature`.
- **Plan B** : si le callback n'arrive pas, la page d'attente interroge le statut (au plus une fois toutes les 5 s par transaction).
- Une demande non confirmée **expire après 10 min** (vérification toutes les 30 s). Si l'opérateur confirme quand même plus tard, le paiement est honoré, puisque l'argent a été débité.
- Limites : au plus 2 paiements en attente et 10 demandes par heure par compte. Seul le propriétaire peut booster son annonce, et elle doit être active.

**Administration** :
- Le tableau de bord affiche les recettes (aujourd'hui, 30 jours, total ; paiements réussis hors exemples) et le nombre d'annonces boostées.
- `/admin/paiements` : filtres par statut, opérateur, période et référence/numéro, avec les totaux.
- **Marquer remboursé** : retire la durée achetée. Le remboursement lui-même doit être fait à la main chez l'opérateur.
- `/admin/boosts` : modification des tarifs.
- Toutes ces actions sont inscrites au journal.

### Variables d'environnement (paiements)
| Variable | Rôle |
|---|---|
| `PAYMENT_PROVIDER` | `dev` (défaut) : paiements **simulés** (bandeau « Mode test », boutons Réussite / Échec). `live` : vrais paiements ; chaque opérateur est actif seulement si ses identifiants sont définis |
| `PUBLIC_BASE_URL` | URL publique **HTTPS** du site (ex. `https://omoni.cg`), pour les callbacks |
| `MTN_BASE_URL` | `https://sandbox.momodeveloper.mtn.com` (test) ou l'URL de production fournie par MTN |
| `MTN_SUBSCRIPTION_KEY` | clé d'abonnement au produit **Collections** (`Ocp-Apim-Subscription-Key`) |
| `MTN_API_USER`, `MTN_API_KEY` | API user (UUID) et API key |
| `MTN_TARGET_ENV` | `sandbox` ou l'environnement de production donné par MTN (ex. `mtncongo`) |
| `MTN_CURRENCY` | `XAF` (le **bac à sable n'accepte que `EUR`**) |
| `AIRTEL_BASE_URL` | `https://openapiuat.airtel.africa` (staging) ou `https://openapi.airtel.africa` (production) |
| `AIRTEL_CLIENT_ID`, `AIRTEL_CLIENT_SECRET` | identifiants OAuth2 de l'application Airtel |
| `AIRTEL_COUNTRY`, `AIRTEL_CURRENCY` | `CG` et `XAF` (valeurs par défaut) |
| `AIRTEL_CALLBACK_SECRET` | secret de signature des callbacks, si activé dans le portail Airtel (facultatif) |

URL de callback à déclarer : MTN reçoit la sienne automatiquement à chaque demande (`/webhooks/mtn/<ref>?t=…`).
Pour Airtel, déclarer `https://<votre-domaine>/webhooks/airtel` dans le portail.

### Passer aux vrais paiements : démarches
> ⚠ Les intégrations `mtn` et `airtel` de `payments.js` suivent la documentation publique, mais **elles n'ont pas été testées** contre les vraies API.
> Il faut les valider d'abord en sandbox/staging, puis avec de petits montants réels.

**Prérequis communs** : une **entreprise enregistrée** au Congo, avec :
- RCCM ;
- NIU (numéro d'identification unique fiscal) ;
- statuts ;
- pièce d'identité du gérant ;
- justificatif d'adresse ;
- compte bancaire (ou compte marchand) pour recevoir les fonds.

Il faut aussi un nom de domaine et un hébergement **HTTPS**. Les opérateurs prennent une commission par transaction, à négocier.

**MTN MoMo (MTN Congo)**
1. Créer un compte sur **momodeveloper.mtn.com** et s'abonner au produit **Collections**, ce qui donne une *subscription key*.
2. En sandbox, créer un *API user* (`POST /v1_0/apiuser`) et une *API key*. Tester avec `MTN_TARGET_ENV=sandbox`, `MTN_CURRENCY=EUR` et les numéros de test MTN.
3. Demander un **compte marchand MoMo / contrat « Collections »** auprès de **MTN Congo** (service entreprises / MoMo Business), avec le dossier KYC de l'entreprise.
4. Après validation, MTN ouvre l'accès **production** (Go Live sur le portail). Vous recevez :
   - l'environnement cible (ex. `mtncongo`) ;
   - l'URL de base ;
   - les identifiants de production.

   Régler alors `MTN_CURRENCY=XAF`.

**Airtel Money (Airtel Congo)**
1. Créer un compte sur **developers.airtel.africa**, créer une application et ajouter le produit **Collection** (pays : Congo-Brazzaville, `CG`). Vous obtenez le *client id* et le *client secret* de **staging**.
2. Tester sur `openapiuat.airtel.africa`. Déclarer l'URL de callback et, si possible, activer la signature des callbacks.
3. Faire la demande de **passage en production** depuis le portail : dossier KYC de l'entreprise et contrat marchand signé avec **Airtel Congo**.
   - Airtel peut exiger le **chiffrement du PIN / des messages** (clé publique RSA fournie par le portail). Ce n'est pas implémenté ici ; à ajouter si Airtel l'impose.
4. Après validation, utiliser les identifiants de production et `AIRTEL_BASE_URL=https://openapi.airtel.africa`.

**Alternative : un agrégateur** (CinetPay, PayDunya, Flutterwave…). Un seul contrat et une seule API couvrent MTN et Airtel au Congo, ce qui rend souvent l'ouverture plus simple et plus rapide, en échange d'une commission plus élevée.
Pour l'utiliser, ajouter un fournisseur `{ requestToPay, getStatus }` dans `payments.js` (emplacement prévu et commenté).

> ⚠ Ne jamais mettre le site en ligne avec `PAYMENT_PROVIDER=dev` : n'importe qui pourrait s'offrir des boosts gratuits.

## Déploiement d'essai (Render, offre gratuite)
Fichiers : `render.yaml` (Blueprint), `Dockerfile` (alternative), `.node-version` (22) et `engines.node = 22.x`.
La seule dépendance « native » est **SQLite**, fourni par Node lui-même (`node:sqlite`, Node ≥ 22.13), donc il n'y a **aucune compilation** au build.
`express` et `multer` sont du JavaScript pur.

1. Pousser ce dépôt sur GitHub/GitLab.
2. Sur Render, choisir **New → Blueprint** et sélectionner le dépôt.
3. Saisir **`SITE_PASSWORD`** quand Render le demande.

Variables du Blueprint :

| Variable | Valeur |
|---|---|
| `NODE_ENV` | `production` |
| `SMS_PROVIDER` | `dev` |
| `PAYMENT_PROVIDER` | `dev` |
| `SESSION_SECRET` | générée par Render |
| `SITE_PASSWORD` | à saisir |

Render fournit `PORT`. Le serveur écoute sur `0.0.0.0:$PORT`, et la sonde de santé est `GET /healthz`.

- **Mot de passe du site** (`SITE_PASSWORD`) : quand il est défini, tout le site est protégé, y compris les photos, `/admin` et les callbacks `/webhooks/*`.
  - Exceptions : `/healthz` et la feuille de style.
  - Page **`/acces`** en français : cookie signé `HttpOnly` valable 30 jours, invalidé si le mot de passe change.
  - Repli **HTTP Basic Auth**, avec n'importe quel identifiant (ex. `curl -u x:MOTDEPASSE`).
  - Comparaison en temps constant. 10 échecs / 15 min par IP, 200 / 15 min au total. `noindex`.
- **Disque éphémère** : la base SQLite (`data/`) et les photos (`uploads/`) sont effacées à chaque redémarrage, mise en veille (après ~15 min sans visite) ou déploiement.
  - Au démarrage, si la base est vide, les **données d'exemple sont recréées automatiquement** : annonces et photos, comptes de démo dont l'**admin +242 06 000 00 01**, conversations, boosts et paiements d'exemple.
  - Pour désactiver ce comportement : `AUTO_SEED=0`.
- `SESSION_SECRET` doit être fixe (sinon avertissement au démarrage, et le secret est régénéré à chaque redémarrage sur disque éphémère).
- Variables facultatives : `HOST` (défaut `0.0.0.0`) et `AUTO_SEED`.

Docker :
```
docker build -t omoni .
docker run -p 3000:3000 -e SESSION_SECRET=… -e SITE_PASSWORD=… omoni
```

Tests du mot de passe : `SITE_PASSWORD=… npm run test:gate`. Avec `SITE_PASSWORD` défini, `npm run test:e2e` s'authentifie automatiquement (HTTP Basic).

## Tests
`npm run test:e2e` (`tests/e2e.js`) : parcours complet dans un navigateur headless — connexion par code, dépôt, modification, renouvellement (+ délai 24 h),
expiration, vendu, suppression, favoris, accès refusé à l'annonce d'un autre, CSRF, puis administration : 403 pour un non-admin, signalement → masquer → rétablir,
pré-modération approuver / refuser, mots interdits, suppression, bannissement → connexion refusée → débannissement, journal ; messagerie : démarrer une
conversation, réponse + actualisation automatique, non-lus, envoi sans JS, 403 pour un non-participant, blocage, signalement → lecture admin, mots interdits,
utilisateur banni, limite d'envoi ; paiements : achat de boost réussi, échoué, expiré, callbacks rejoués (idempotence) et non signés,
impossible de booster l'annonce d'un autre, badges affichés puis expirés, Mes paiements, remboursement, tarifs, journal. Nécessite `playwright-core`
et Chrome (`npm i -D playwright-core` ; variables `CHROME`, `BASE_URL`, `PLAYWRIGHT_CORE` facultatives ; `--no-shots` pour ne pas refaire les captures).
`npm run test:clean` efface ensuite les données de test (garde les exemples, les signalements, conversations, boosts et paiements d'exemple, et remet les tarifs par défaut).

## Structure
`server.js` (routes + pages) · `gate.js` (mot de passe du site, /healthz) · `messages.js` (messagerie) · `boosts.js` (boosts, pages de paiement, webhooks) · `payments.js` (fournisseurs Mobile Money) · `admin.js` (panneau d'administration) · `scripts/admin.js` (CLI admin) · `auth.js` · `sms.js` · `db.js` (schéma + migrations) · `config.js` (marque, villes, catégories, durées) · `public/` · `seed/` · `tests/`
