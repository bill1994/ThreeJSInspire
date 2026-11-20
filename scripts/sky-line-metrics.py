"""Regression for sky-line-probe's fixed daylight frame, not a generic dark-pixel test.
The clear upper-sky crop excludes clouds, HUD, sea, stars and the canvas border.
Usage: python scripts/sky-line-metrics.py artifacts/sea-sky-line-after-...
"""
import json
import sys
from pathlib import Path
from PIL import Image

root = Path(sys.argv[1])
reports = []
for name in ("flight-raw.png", "sunward-raw.png"):
    roi = Image.open(root / name).convert("RGB").crop((70, 4, 330, 140))
    defects = sum(max(rgb) < 160 for rgb in roi.get_flattened_data())
    reports.append({"image": name, "dark_sky_pixels": defects})
print(json.dumps(reports))
if any(r["dark_sky_pixels"] for r in reports):
    raise SystemExit("Solar-meridian dark pixel regression")
