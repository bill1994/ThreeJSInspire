import os
import numpy as np
from PIL import Image
HERE=os.path.abspath('artifacts/sea-review'); OUT=os.path.abspath('artifacts/sea-audit')
def load(n): return np.asarray(Image.open(os.path.join(HERE,n+'.png')).convert('RGB'),dtype=np.float32)
def luma(a): return a[...,0]*0.2126+a[...,1]*0.7152+a[...,2]*0.0722
def crop(src,box,scale,name):
    a=Image.open(os.path.join(HERE,src+'.png')).convert('RGB'); c=a.crop(box)
    c=c.resize((c.width*scale,c.height*scale),Image.NEAREST); c.save(os.path.join(OUT,name))
for n in ['H060-alt60','H060-post-on','916-H060-alt60','916-H020-alt20']:
    if not os.path.exists(os.path.join(HERE,n+'.png')): continue
    a=load(n); y=luma(a)
    x0,x1=80,640
    if a.shape[1]==560: x0,x1=0,560
    prof=y[:,x0:x1].mean(axis=1)
    d=np.abs(np.diff(prof))
    # rows in lower half with a local spike (line) or step
    lo=int(0.55*a.shape[0])
    idx=np.argsort(d[lo:])[-12:]+lo
    print(n, 'top row-gradient rows:', sorted(int(i) for i in idx), 'vals:', [round(float(d[i]),2) for i in sorted(idx)])
crop('H060-alt60',(80,940,640,1020),3,'h060-985.png')
crop('H060-alt60',(80,740,640,820),3,'h060-780.png')
crop('916-H060-alt60',(0,730,560,800),3,'916-h060-765.png')
crop('916-H020-alt20',(0,730,560,800),3,'916-h020-765.png')
print('ok')
