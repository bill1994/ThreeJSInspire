import os
import numpy as np
from PIL import Image
HERE=os.path.abspath('artifacts/sea-review')
def load(n): return np.asarray(Image.open(os.path.join(HERE,n+'.png')).convert('RGB'),dtype=np.float32)
def luma(a): return a[...,0]*0.2126+a[...,1]*0.7152+a[...,2]*0.0722
def span(name, rows, thresh=110, x0=None, x1=None):
    a=load(name); y=luma(a); H,W=y.shape
    if x0 is None: x0,x1=0,W
    sub=y[rows[0]:rows[1], x0:x1]
    dark=(sub<thresh)
    cols=np.where(dark.sum(axis=0)>=2)[0]
    if not len(cols): return None
    return int(cols[-1]-cols[0]+1), int(sub.shape[1])
print('sea-off', span('H020-sea-off',(560,730),105,80,640))
for n,rows in [('916-H007-alt7',(360,440)),('916-H020-alt20',(360,440)),('916-H060-alt60',(360,440))]:
    print(n, span(n,rows,110))
print('H240', span('H240-alt240',(560,760),105,80,640))
print('H060', span('H060-alt60',(540,720),100,80,640))
