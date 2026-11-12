import json, os
import numpy as np
from PIL import Image

HERE = os.path.abspath('artifacts/sea-review')
OUT = os.path.abspath('artifacts/sea-audit')
os.makedirs(OUT, exist_ok=True)

def load(n):
    return np.asarray(Image.open(os.path.join(HERE, n + '.png')).convert('RGB'), dtype=np.float32)

def luma(a):
    return a[...,0]*0.2126 + a[...,1]*0.7152 + a[...,2]*0.0722

def bounds(a):
    col = luma(a).mean(axis=0)
    keep = np.where(col > 45)[0]
    return int(keep[0]), int(keep[-1]+1)

rep = {}
for n in ['H240-alt240','H120-alt120','H060-alt60','H060-post-on','H020-alt20','H007-alt7','SKIM-dive7','H020-debug','H007-grazing','H007-topdown','916-H007-alt7','916-H020-alt20','916-H060-alt60']:
    p = os.path.join(HERE, n + '.png')
    if not os.path.exists(p): continue
    a = load(n); y = luma(a); x0,x1 = bounds(a); H = y.shape[0]
    prof = y[:, x0:x1].mean(axis=1)
    d = np.abs(np.diff(prof))
    lo,hi = int(0.22*H), int(0.55*H)
    hor = int(lo + np.argmax(d[lo:hi]))
    dx = np.abs(np.diff(y[:, x0:x1], axis=0))
    frac = (dx > 5).mean(axis=1)
    rows = np.where(frac > 0.70)[0]
    groups=[]
    for r in rows:
        if groups and r-groups[-1][-1]<=2: groups[-1].append(int(r))
        else: groups.append([int(r)])
    rep[n] = dict(size=[int(a.shape[1]),int(a.shape[0])], canvas=[x0,x1], horizon_row=hor,
                  horizon_frac=round(hor/H,3), straight_rows=[g[0] for g in groups][:8],
                  straight_frac=[round(float(frac[g[0]]),2) for g in groups][:8])
    y0,y1 = int(0.26*H), int(0.62*H)
    blk = (y[y0:y1, x0:x1] < 105)
    colcount = blk.sum(axis=0)
    cols = np.where(colcount >= 2)[0]
    if len(cols):
        rep[n]['dark_span_px'] = int(cols[-1]-cols[0]+1)
        rep[n]['dark_span_frac_canvas'] = round(float((cols[-1]-cols[0]+1)/(x1-x0)),3)

print(json.dumps(rep, indent=2))
with open(os.path.join(OUT,'audit.json'),'w',encoding='utf-8') as f: json.dump(rep,f,indent=2)

def crop(src, box, scale, name):
    a = Image.open(os.path.join(HERE, src + '.png')).convert('RGB')
    c = a.crop(box)
    c = c.resize((c.width*scale, c.height*scale), Image.NEAREST)
    c.save(os.path.join(OUT, name))
    return c.size

crop('H020-debug', (80, 900, 640, 1060), 2, 'seam-H020-debug.png')
crop('H020-alt20', (80, 900, 640, 1060), 2, 'seam-H020-alt20.png')
crop('H060-alt60', (80, 900, 640, 1060), 2, 'seam-H060-alt60.png')
crop('H060-alt60', (80, 730, 640, 840), 3, 'line-H060-780.png')
crop('916-H007-alt7', (200, 600, 360, 995), 3, 'wake-916.png')
crop('H007-grazing', (80, 900, 640, 1280), 1, 'grazing-near.png')
crop('H007-grazing', (500, 200, 620, 300), 4, 'grazing-diamond.png')
print('crops ok')
