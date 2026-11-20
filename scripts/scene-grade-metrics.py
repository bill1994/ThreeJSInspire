"""Aircraft-only A/B image checks. Requires Pillow; pass scene-grade-probe output directory."""
import json
import sys
from pathlib import Path
from PIL import Image

root=Path(sys.argv[1])
results={}
for hour in (12,0):
    frames=[Image.open(root/f'{hour}-plane-{v}.png').convert('RGB') for v in ('previous','refined')]
    # Use the union mask so brighter night pixels do not change the sample set.
    mask=[(x,y) for x in range(175,395) for y in range(365,455)
          if max(max(im.getpixel((x,y))) for im in frames)>12]
    assert len(mask)>1000, 'Aircraft missing from capture'
    for version,frame in zip(('previous','refined'),frames):
        values=sorted(sum(frame.getpixel(p))/3 for p in mask)
        results[f'{hour}-{version}']={'mean':sum(values)/len(values),'p95':values[int(len(values)*.95)],'pixels':len(mask)}
old_day,new_day=(results[f'12-{v}'] for v in ('previous','refined'))
old_night,new_night=(results[f'0-{v}'] for v in ('previous','refined'))
assert .75<new_day['p95']/old_day['p95']<.95, 'Noon highlight reduction drifted'
assert new_night['mean']>old_night['mean']*1.5, 'Night aircraft still lacks fill'
assert new_night['mean']<new_day['mean']*.75, 'Night aircraft looks day-lit'
(root/'plane-metrics.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
print(json.dumps(results,indent=2))
