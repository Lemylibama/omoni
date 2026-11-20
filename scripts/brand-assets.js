// Génère les fichiers de marque dans public/brand/ à partir de brand.js : node scripts/brand-assets.js
// (Les PNG — favicon 32 px, icône 180/512 px, image de partage — sont rendus depuis ces SVG avec un navigateur headless.)
const fs = require('fs'); const path = require('path'); const b = require('../brand');
const OUT = path.join(__dirname, '..', 'public', 'brand'); fs.mkdirSync(OUT, { recursive: true });
const w = (f, s) => fs.writeFileSync(path.join(OUT, f), s + '\n');
w('logo.svg', b.wordmarkA());
w('logo-white.svg', b.wordmarkA('ow', '#FFFFFF'));
w('logo-mark.svg', b.markA());
w('favicon.svg', b.markA('fv'));
// Icône d'application plein cadre (iOS/Android arrondissent eux-mêmes les coins).
w('app-icon.svg', b.markA('ai').replace('rx="15" ', ''));
const { P } = b;
w('og-image.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
<rect width="1200" height="630" fill="${P.paper}"/>
<path d="M760 630 1200 190V630z" fill="${P.flag}"/><path d="M640 630 1200 70v120L760 630z" fill="${P.sun}"/><path d="M520 630 1200-50V70L640 630z" fill="${P.leaf}"/>
<g transform="translate(90 170) scale(2.6)">${b.wordmarkA('og').replace(/^<svg[^>]*>|<\/svg>$/g, '').replace(/<title>.*?<\/title>/, '')}</g>
<text x="92" y="430" font-family="Bricolage Grotesque, Arial Black, sans-serif" font-weight="800" font-size="46" fill="${P.ink}">Achetez et vendez</text>
<text x="92" y="484" font-family="Bricolage Grotesque, Arial Black, sans-serif" font-weight="800" font-size="46" fill="${P.ink}">près de chez vous</text>
<text x="92" y="540" font-family="Atkinson Hyperlegible Next, Arial, sans-serif" font-size="28" fill="#5A655E">Petites annonces · République du Congo</text>
</svg>`);
console.log('Fichiers écrits dans', OUT);
