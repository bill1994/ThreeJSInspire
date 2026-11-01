"""Measure the gap between a reference frame and a live QA capture.

Both inputs are cropped to their real content (black letterbox bars and the
dark page background around the portrait game column are removed first), then
compared with scale-free statistics, so a 700x398 landscape reference and a
900x900 portrait capture can be put on one table.

Claims measured here:
  C1 palette      dominant colours + how much chroma each one carries
  C2 sky          saturation and the top-to-horizon value swing
  C3 cloud mass   coverage, blob count, blob aspect (tower vs balloon)
  C4 cloud tone   effective tone levels inside the cloud mask (NPR banding)
  C5 sea          relative sparkle energy and sun-road concentration

Usage: python artifacts/cloud-audit/ref_gap_measure.py REF CURRENT
"""
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.cluster.vq import kmeans2

np.random.seed(7)


def srgb_to_lab(rgb):
    r = rgb.reshape(-1, 3)
    lin = np.where(r <= 0.04045, r / 12.92, ((r + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    L = 116 * f[:, 1] - 16
    a = 500 * (f[:, 0] - f[:, 1])
    b = 200 * (f[:, 1] - f[:, 2])
    return np.stack([L, a, b], 1)


def hsv(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(-1), rgb.min(-1)
    d = mx - mn
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    h = np.zeros_like(mx)
    m = d > 1e-6
    idx = (mx == r) & m
    h[idx] = ((g - b)[idx] / d[idx]) % 6
    idx = (mx == g) & m
    h[idx] = ((b - r)[idx] / d[idx]) + 2
    idx = (mx == b) & m
    h[idx] = ((r - g)[idx] / d[idx]) + 4
    return h * 60.0, s, mx


def content_crop(path):
    """Trim black bars, then the dark page surround of a portrait game column."""
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float32) / 255.0
    for _ in range(2):
        rm, cmx = a.mean(axis=(1, 2)), a.mean(axis=(0, 2))
        rows = rm > 0.5 * np.median(rm)
        cols = cmx > 0.5 * np.median(cmx)
        if rows.sum() > 0.5 * len(rows):
            a = a[rows]
        if cols.sum() > 0.5 * len(cols):
            a = a[:, cols]
    cm = a.mean(axis=(0, 2))
    keep = cm > np.median(cm) + 0.02
    if keep.sum() > 0.25 * len(keep):
        xs = np.where(keep)[0]
        a = a[:, xs.min():xs.max() + 1]
    return a


def palette(a, k=8):
    small = a[::4, ::4].reshape(-1, 3)
    lab = srgb_to_lab(small)
    cent, lbl = kmeans2(lab, k, minit="++", seed=7)
    out = []
    for i in range(k):
        m = lbl == i
        if m.sum() == 0:
            continue
        c = cent[i]
        out.append({
            "share": round(float(m.mean()), 3),
            "L": round(float(c[0]), 1),
            "a": round(float(c[1]), 1),
            "b": round(float(c[2]), 1),
            "chroma": round(float(np.hypot(c[1], c[2])), 1),
        })
    return sorted(out, key=lambda d: -d["share"])


def bands(a):
    H = a.shape[0]
    return {
        "sky": a[0:int(H * 0.30)],
        "cloud": a[int(H * 0.25):int(H * 0.62)],
        "sea": a[int(H * 0.70):H],
    }


def cloud_mask(a):
    """Dark, saturated violet-magenta mass. Sky is bright; sun-road is orange."""
    h, s, v = hsv(a)
    purple = ((h > 225) & (h < 330)) | (h > 330)
    return purple & (s > 0.12) & (v < 0.72)


def measure(a):
    H, W, _ = a.shape
    h, s, v = hsv(a)
    b = bands(a)
    res = {"size": [W, H]}

    # C2 sky
    sky = b["sky"]
    sh, ss, sv = hsv(sky)
    res["sky_sat_mean"] = round(float(ss.mean()), 3)
    top = float(sv[:int(H * 0.08)].mean())
    hor = float(sv[int(H * 0.24):int(H * 0.30)].mean())
    res["sky_value_top"] = round(top, 3)
    res["sky_value_horizon"] = round(hor, 3)
    res["sky_value_swing"] = round(abs(top - hor), 3)
    res["sky_sat_max"] = round(float(np.percentile(ss, 98)), 3)

    # C3/C4 cloud mass
    cm = cloud_mask(b["cloud"])
    res["cloud_coverage"] = round(float(cm.mean()), 3)
    lab, n = ndimage.label(cm)
    areas = ndimage.sum(cm, lab, range(1, n + 1))
    big = [i + 1 for i, ar in enumerate(areas) if ar > 0.002 * cm.size]
    res["cloud_blobs"] = len(big)
    if big:
        asp = []
        for i in big:
            ys, xs = np.where(lab == i)
            asp.append((ys.max() - ys.min() + 1) / max(1, xs.max() - xs.min() + 1))
        res["cloud_aspect_median"] = round(float(np.median(asp)), 2)
        res["cloud_aspect_max"] = round(float(np.max(asp)), 2)
        res["cloud_blob_area_frac_median"] = round(float(np.median([areas[i - 1] for i in big]) / cm.size), 4)
    else:
        res["cloud_aspect_median"] = None
        res["cloud_aspect_max"] = None
        res["cloud_blob_area_frac_median"] = None
    ch, cs, cval = hsv(b["cloud"])
    cv = cval[cm]
    if cv.size > 500:
        hist, _ = np.histogram(cv, bins=16, range=(0, 1))
        share = hist / hist.sum()
        res["cloud_tone_levels"] = int((share > 0.02).sum())
        res["cloud_tone_span"] = round(float(np.percentile(cv, 92) - np.percentile(cv, 8)), 3)
        res["cloud_value_mean"] = round(float(cv.mean()), 3)
    else:
        res["cloud_tone_levels"] = None
        res["cloud_tone_span"] = None
        res["cloud_value_mean"] = None
    res["cloud_sat_mean"] = round(float(cs.mean()), 3)

    # C5 sea
    sea = b["sea"]
    lum = sea.mean(-1)
    lap = np.zeros_like(lum)
    lap[1:-1, 1:-1] = (4 * lum[1:-1, 1:-1] - lum[:-2, 1:-1] - lum[2:, 1:-1]
                       - lum[1:-1, :-2] - lum[1:-1, 2:])
    res["sea_sparkle_rel"] = round(float(np.var(lap) / max(lum.mean(), 1e-6) ** 2), 5)
    col = lum.mean(axis=0)
    res["sea_sunroad_ratio"] = round(float(np.percentile(col, 98) / max(np.median(col), 1e-6)), 2)
    res["sea_sunroad_width_frac"] = round(float((col > 1.35 * np.median(col)).mean()), 3)
    sh2, ss2, sv2 = hsv(sea)
    res["sea_sat_mean"] = round(float(ss2.mean()), 3)
    res["sea_value_mean"] = round(float(sv2.mean()), 3)

    # global
    res["lum_std"] = round(float(a.mean(-1).std()), 3)
    res["sat_mean"] = round(float(s.mean()), 3)
    res["palette"] = palette(a)
    return res


def main():
    ref = content_crop(sys.argv[1])
    cur = content_crop(sys.argv[2])
    r, c = measure(ref), measure(cur)
    print(json.dumps({"ref": sys.argv[1], "current": sys.argv[2],
                      "ref_metrics": r, "current_metrics": c}, indent=2))


if __name__ == "__main__":
    main()
