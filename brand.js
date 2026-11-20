// Identité visuelle OMONI — logos en SVG écrits à la main (aucune image externe).
// Palette « Congo fier » : inspirée du drapeau (vert, jaune, rouge en diagonale), modernisée et contrastée (WCAG AA).
const P = {
  forest: '#0B5D3B',  // Forêt — couleur principale (texte blanc : 7,9:1)
  night: '#08462C',   // Forêt nuit — survol, fonds sombres
  leaf: '#009543',    // Vert drapeau — décor uniquement
  sun: '#FBDE4A',     // Soleil — accent (texte encre : 12,5:1)
  flame: '#C81E1A',   // Braise — appels à l'action (texte blanc : 5,7:1)
  flag: '#DC241F',    // Rouge drapeau — décor uniquement
  ink: '#14201A',     // Encre — texte
  paper: '#FBF7EE',   // Papier — fond
};

// L'anneau « O » traversé par la bande diagonale du drapeau (vert en haut à gauche, jaune au milieu, rouge en bas à droite).
function ring(id, cx, cy, r, w, { band = 12, c = [P.leaf, P.sun, P.flag] } = {}) {
  const s = r + w; // demi-côté de la zone colorée (pivotée de -45°)
  return `<mask id="${id}" maskUnits="userSpaceOnUse" x="${cx - s}" y="${cy - s}" width="${2 * s}" height="${2 * s}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#fff" stroke-width="${w}"/></mask>`
    + `<g mask="url(#${id})"><g transform="rotate(-45 ${cx} ${cy})">`
    + `<rect x="${cx - s}" y="${cy - s}" width="${2 * s}" height="${s - band / 2}" fill="${c[0]}"/>`
    + `<rect x="${cx - s}" y="${cy - band / 2}" width="${2 * s}" height="${band}" fill="${c[1]}"/>`
    + `<rect x="${cx - s}" y="${cy + band / 2}" width="${2 * s}" height="${s - band / 2}" fill="${c[2]}"/></g></g>`;
}
// Lettres géométriques « MONI » (polygones pleins, hauteur de capitale 44 sur une grille de 64).
const M = (x) => `<path d="M${x} 54V10h10l13 21 13-21h10v44h-11V30l-9 15h-6l-9-15v24z"/>`;
const N = (x) => `<path d="M${x} 54V10h10l21 28V10h11v44h-10L${x + 11} 26v28z"/>`;
const I = (x) => `<rect x="${x}" y="10" width="11" height="44"/>`;
const O = (cx) => `<circle cx="${cx}" cy="32" r="16.5" fill="none" stroke="currentColor" stroke-width="11"/>`;
const MONI = (x0, color) => `<g fill="${color}" color="${color}">${M(x0)}${O(x0 + 75)}${N(x0 + 104)}${I(x0 + 152)}</g>`;

// ---- Variante A (recommandée) : « Anneau-bande » ----
const wordmarkA = (id = 'oa', color = P.forest, ringC) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 216 64" role="img" aria-label="OMONI"><title>OMONI</title>${ring(id, 23, 32, 16.5, 11, ringC ? { c: ringC } : {})}${MONI(52, color)}</svg>`;
const markA = (id = 'ma') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="OMONI"><title>OMONI</title><rect width="64" height="64" rx="15" fill="${P.ink}"/>${ring(id, 32, 32, 15, 11, { band: 11 })}</svg>`;

// ---- Variante B : « Étiquette » (étiquette de prix, bande diagonale, œillet en forme de O) ----
const tag = (id, x = 0, y = 0, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><clipPath id="${id}"><path d="M22 6h30a6 6 0 0 1 6 6v40a6 6 0 0 1-6 6H22L4 32z"/></clipPath><g clip-path="url(#${id})"><rect width="64" height="64" fill="${P.forest}"/><path d="M14 64 64 14v18L32 64z" fill="${P.sun}"/><path d="M32 64 64 32v32z" fill="${P.flag}"/></g><circle cx="21" cy="32" r="5.5" fill="${P.paper}"/></g>`;
const wordmarkB = (id = 'tb') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 290 64" role="img" aria-label="OMONI"><title>OMONI</title>${tag(id)}<g fill="${P.ink}" color="${P.ink}">${O(97)}${M(126)}${O(201)}${N(230)}${I(278)}</g></svg>`;
const markB = (id = 'mb') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="OMONI"><title>OMONI</title><rect width="64" height="64" rx="15" fill="${P.paper}"/>${tag(id, 3, 3, 0.9)}</svg>`;

// ---- Variante C : « Repère » (épingle de carte : « près de chez vous ») ----
const pin = (id, x = 0, y = 0, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><clipPath id="${id}"><path d="M32 62C20 47 10 37 10 25a22 22 0 0 1 44 0c0 12-10 22-22 37z"/></clipPath><g clip-path="url(#${id})"><rect width="64" height="64" fill="${P.flame}"/><path d="M0 46 46 0h12L0 58z" fill="${P.sun}"/><path d="M0 46 46 0H0z" fill="${P.forest}"/></g><circle cx="32" cy="25" r="9" fill="${P.paper}"/></g>`;
const wordmarkC = (id = 'pc') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 230 64" role="img" aria-label="OMONI"><title>OMONI</title><g fill="${P.forest}" color="${P.forest}">${O(23)}${M(52)}</g>${pin(id, 104, 0, 1)}<g fill="${P.forest}">${N(170)}${I(218)}</g></svg>`;
const markC = (id = 'mc') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="OMONI"><title>OMONI</title><rect width="64" height="64" rx="15" fill="${P.paper}"/>${pin(id, 4, 3, 0.88)}</svg>`;

// Motif signature : bandes diagonales vert / jaune / rouge (CSS, voir .stripe dans style.css).
module.exports = { P, wordmarkA, markA, wordmarkB, markB, wordmarkC, markC, ring };
// Balises <head> communes (icônes, thème, police préchargée) — tout est servi localement depuis /static.
module.exports.HEAD = `<meta name="theme-color" content="${P.forest}">
<link rel="icon" href="/static/brand/favicon.svg" type="image/svg+xml"><link rel="icon" href="/static/brand/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/static/brand/apple-touch-icon.png"><link rel="manifest" href="/static/manifest.webmanifest">
<link rel="preload" href="/static/fonts/bricolage-grotesque-800.woff2" as="font" type="font/woff2" crossorigin>`;
