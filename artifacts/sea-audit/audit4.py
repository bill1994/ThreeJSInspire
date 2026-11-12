import os
from PIL import Image
HERE=os.path.abspath('artifacts/sea-review'); OUT=os.path.abspath('artifacts/sea-audit')
for n,box,name in [('H020-sea-off',(200,850,440,1280),'seaoff-bottom.png'),('H020-alt20',(200,850,440,1280),'seaon-bottom.png')]:
    a=Image.open(os.path.join(HERE,n+'.png')).convert('RGB').crop(box)
    a=a.resize((a.width*2,a.height*2),Image.NEAREST); a.save(os.path.join(OUT,name))
print('ok')
