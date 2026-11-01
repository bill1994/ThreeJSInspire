"""Compare the three reference frames against live captures of the running scene.

Each pair is measured with the same statistics as ref_gap_measure.py plus one
extra: a polar angular profile that isolates radial speed lines (their contrast
against the underlying frame, and how many separate lines cross a ring).

Usage: python artifacts/cloud-audit/ref_gap_three.py
"""
import importlib.util
import json

import numpy as np

spec = importlib.util.spec_from_file_location("m", "artifacts/cloud-audit/ref_gap_measure.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

PAIRS = [
    ("ref-01 sunset glide", "docs/superpowers/specs/assets/ref-01-sunset-glide.png",
     "artifacts/cloud-audit/live/live-cruise-alt60.png"),
    ("ref-02 speed lines", "docs/superpowers/specs/assets/ref-02-speed-lines.png",
     "artifacts/cloud-audit/live/live-dive-alt200.png"),
    ("ref-03 spiral dive", "docs/superpowers/specs/assets/ref-03-spiral-dive.png",
     "artifacts/cloud-audit/live/live-bankdive-alt220.png"),
]


def angular_streaks(a, radii=(0.40, 0.50, 0.60, 0.70, 0.80, 0.88)):
    """Radial line detector: ring profiles in polar space, measured for peaks."""
    h, w, _ = a.shape
    s = min(h, w)
    sq = a[(h - s) // 2:(h - s) // 2 + s, (w - s) // 2:(w - s) // 2 + s]
    lum = sq.mean(-1)
    c = s / 2.0
    th = np.linspace(0, 2 * np.pi, 1440, endpoint=False)
    con, cnt = [], []
    for rf in radii:
        r = rf * (s / 2)
        xs = np.clip((c + np.cos(th) * r).astype(int), 0, s - 1)
        ys = np.clip((c + np.sin(th) * r).astype(int), 0, s - 1)
        prof = lum[ys, xs]
        mu, sd = prof.mean(), prof.std()
        if mu <= 1e-6:
            continue
        con.append(sd / mu)
        hi = (prof > mu + sd).view(np.int8)
        runs = int(np.sum(np.diff(np.r_[0, hi, 0]) == 1))
        cnt.append(runs)
    if not con:
        return {"streak_contrast": None, "streak_count": None}
    return {"streak_contrast": round(float(np.mean(con)), 3),
            "streak_count": int(round(float(np.mean(cnt))))}


def tone(a):
    lab = m.srgb_to_lab(a.reshape(-1, 3))
    L, C = lab[:, 0], np.hypot(lab[:, 1], lab[:, 2])
    return {
        "median_L": round(float(np.median(L)), 1),
        "median_C": round(float(np.median(C)), 1),
        "dark_frac": round(float((L < 12).mean()), 3),
        "vivid_frac": round(float((C > 35).mean()), 3),
        "grey_frac": round(float((C < 15).mean()), 3),
    }


def run():
    out = []
    for name, ref_p, cur_p in PAIRS:
        ref, cur = m.content_crop(ref_p), m.content_crop(cur_p)
        rm, cm = m.measure(ref), m.measure(cur)
        rt, ct = tone(ref), tone(cur)
        rs, cs = angular_streaks(ref), angular_streaks(cur)
        out.append({
            "pair": name,
            "ref_size": rm["size"], "cur_size": cm["size"],
            "tone_ref": rt, "tone_cur": ct,
            "ref": {k: rm[k] for k in ("sky_sat_max", "cloud_value_mean", "cloud_blobs",
                                       "cloud_blob_area_frac_median", "cloud_coverage",
                                       "sea_sunroad_ratio", "sea_sparkle_rel", "sea_value_mean")},
            "cur": {k: cm[k] for k in ("sky_sat_max", "cloud_value_mean", "cloud_blobs",
                                       "cloud_blob_area_frac_median", "cloud_coverage",
                                       "sea_sunroad_ratio", "sea_sparkle_rel", "sea_value_mean")},
            "streaks_ref": rs, "streaks_cur": cs,
        })
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    run()
