# Génère des images d'exemple simples (aucune photo protégée) pour les annonces de démonstration.
import json, os, hashlib
from PIL import Image, ImageDraw, ImageFont
base = os.path.dirname(__file__)
ads = json.load(open(os.path.join(base, 'ads.json')))
COL = {'vehicules':((14,90,160),(40,150,220)),'immobilier':((150,80,30),(230,160,80)),'electronique':((40,40,70),(90,90,160)),
 'maison':((120,60,90),(210,130,160)),'mode':((170,30,90),(250,120,60)),'emploi':((30,100,100),(80,190,170)),
 'services':((90,70,20),(220,180,40)),'agriculture':((20,110,50),(120,200,80)),'autres':((80,80,80),(170,170,170))}
F = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'; F2 = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
for i, ad in enumerate(ads):
    for j, label in enumerate(ad['img']):
        a, b = COL[ad['category']]; W, H = 800, 600
        im = Image.new('RGB', (W, H)); d = ImageDraw.Draw(im)
        for y in range(H):
            t = y / H; d.line([(0, y), (W, y)], fill=tuple(int(a[k]*(1-t)+b[k]*t) for k in range(3)))
        seed = int(hashlib.md5(label.encode()).hexdigest(), 16)
        for k in range(6):
            r = 40 + (seed >> (k*5)) % 120; x = (seed >> (k*7)) % W; y = (seed >> (k*3)) % H
            d.ellipse([x-r, y-r, x+r, y+r], fill=tuple(min(255, c+25) for c in b))
        f = ImageFont.truetype(F, 64 if len(label) < 14 else 50); f2 = ImageFont.truetype(F2, 26)
        w = d.textlength(label, font=f); d.text(((W-w)/2+3, H/2-37), label, font=f, fill=(0,0,0,90)); d.text(((W-w)/2, H/2-40), label, font=f, fill='white')
        s = 'Photo d\'exemple'; w2 = d.textlength(s, font=f2)
        d.rounded_rectangle([(W-w2)/2-14, H/2+50, (W+w2)/2+14, H/2+92], 20, fill=(0,0,0))
        d.text(((W-w2)/2, H/2+55), s, font=f2, fill='white')
        im.save(os.path.join(base, 'images', f'ex{i+1:02d}-{j+1}.jpg'), quality=72, optimize=True, progressive=True)
print('ok')
