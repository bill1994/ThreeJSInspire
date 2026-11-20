"""Check the fixed-view screenshots from sea-refinement-probe.mjs (requires Pillow).
Usage: python scripts/sea-refinement-metrics.py artifacts/sea-stage2-...
These image checks supplement visual review; they do not score artistic quality.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageFilter, ImageStat

root = Path(sys.argv[1])
results = {}
for hour in (12, 0):
    for version in ('previous', 'refined'):
        # Sea only: below the aircraft, above the subtitles; identical pose/time.
        frame = Image.open(root / f'{hour}-no-road-{version}.png').convert('L')
        region = frame.crop((100, 460, 470, 640))
        raw = ImageStat.Stat(region)
        # Blur removes thin caps so broad wave shapes, not white lines, dominate.
        broad = ImageStat.Stat(region.filter(ImageFilter.GaussianBlur(12)))
        results[f'{hour}-{version}'] = {
            'mean': raw.mean[0],
            'broadContrast': broad.stddev[0] / max(broad.mean[0], 1),
        }

old_day, new_day = (results[f'12-{v}'] for v in ('previous', 'refined'))
old_night, new_night = (results[f'0-{v}'] for v in ('previous', 'refined'))
assert new_day['broadContrast'] > old_day['broadContrast'] * 1.10, 'Broad wave form disappeared'
assert 0.8 < new_day['mean'] / old_day['mean'] < 1.1, 'Day sea exposure drifted too far'
assert new_night['mean'] > old_night['mean'] * 1.25, 'Night body is still too dark'
assert new_night['mean'] < new_day['mean'] * 0.7, 'Night no longer reads as night'
assert new_night['broadContrast'] > old_night['broadContrast'], 'Night lost wave shape'
(root / 'acceptance-metrics.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
print(json.dumps(results, indent=2))
