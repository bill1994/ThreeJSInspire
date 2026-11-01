"""Root-cause measurements for "the clouds and the sea look like noise".

Three questions:
  Q1 cloud spatial frequency  - is the cloud mass low-frequency (bank) or high-frequency (noise)?
  Q2 sea speckle              - how much of the sea's energy is at pixel scale?
  Q3 wedge artifact           - is there a large flat region with a hard edge in the sea band?

All three are scale-free ratios so landscape refs and portrait captures compare.
"""
import importlib.util
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("m", os.path.join(HERE, "ref_gap_measure.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

_spec = importlib.util.spec_from_file_location("st", os.path.join(HERE, "states.py"))
st = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(st)

ndimage = m.ndimage   # numpy stand-ins live in the shared module; no scipy anywhere


def radial_spectrum(gray):
    """Radially averaged power spectrum, normalised to unit total."""
    h, w = gray.shape
    win = np.outer(np.hanning(h), np.hanning(w))
    g = (gray - gray.mean()) * win
    P = np.abs(np.fft.fftshift(np.fft.fft2(g))) ** 2
    fy = np.fft.fftshift(np.fft.fftfreq(h))[:, None]
    fx = np.fft.fftshift(np.fft.fftfreq(w))[None, :]
    r = np.hypot(fy, fx)
    nb = 40
    bins = np.linspace(0, 0.5, nb + 1)
    idx = np.digitize(r.ravel(), bins) - 1
    pw = P.ravel()
    out = np.zeros(nb)
    for i in range(nb):
        sel = idx == i
        if sel.any():
            out[i] = pw[sel].mean()
    out = out / out.sum()
    return bins[:-1] + (bins[1] - bins[0]) / 2, out


def bands(a):
    h = a.shape[0]
    return a[int(h * 0.25):int(h * 0.62)], a[int(h * 0.70):h]


def hf_share(a_band, cut):
    f, p = radial_spectrum(a_band.mean(-1))
    return float(p[f >= cut].sum())


def slope(a_band):
    f, p = radial_spectrum(a_band.mean(-1))
    sel = (f > 0.02) & (p > 0)
    if sel.sum() < 5:
        return None
    return float(np.polyfit(np.log(f[sel]), np.log(p[sel]), 1)[0])


def speckle_count(sea):
    """Local maxima in luminance = the visible white dots."""
    lum = sea.mean(-1)
    mx = ndimage.maximum_filter(lum, size=5)
    peaks = (lum == mx) & (lum > lum.mean() + 1.5 * lum.std())
    lab, n = ndimage.label(peaks)
    return n


def wedge(sea):
    """Largest flat, hard-edged region: low local variance + high gradient at its border."""
    lum = sea.mean(-1)
    v = ndimage.uniform_filter(lum, 9)
    q = ndimage.uniform_filter(lum * lum, 9) - v * v
    flat = q < 0.0004
    lab, n = ndimage.label(flat)
    if n == 0:
        return None
    areas = ndimage.sum(flat, lab, range(1, n + 1))
    i = int(np.argmax(areas))
    if areas[i] < 0.01 * flat.size:
        return {"share": round(float(areas[i] / flat.size), 3), "flat": True}
    ys, xs = np.where(lab == i + 1)
    return {
        "share_of_sea": round(float(areas[i] / flat.size), 3),
        "bbox_h_frac": round(float((ys.max() - ys.min()) / lum.shape[0]), 2),
        "bbox_w_frac": round(float((xs.max() - xs.min()) / lum.shape[1]), 2),
        "std_inside": round(float(lum[lab == i + 1].std()), 4),
        "std_outside": round(float(lum[lab != i + 1].std()), 4),
    }


# Frames come from states.py. These are the frozen protocol captures, not the old
# artifacts/cloud-audit/live/ frames, which are not in the repo.
CASES = [
    ("ref-01", st.path(st.get("A-cruise")["ref"])),
    ("A-cruise", st.path(st.get("A-cruise")["capture"])),
    ("D-skim", st.path(st.get("D-skim")["capture"])),
]

if __name__ == "__main__":
    print("%-12s %8s %8s %10s %10s" % ("case", "cloudHF", "seaHF", "cloudSlope", "seaSlope"))
    for name, path in CASES:
        try:
            a = m.content_crop(path)
        except FileNotFoundError:
            print("%-12s MISSING" % name)
            continue
        cb, sb = bands(a)
        print("%-12s %8.3f %8.3f %10s %10s" % (
            name, hf_share(cb, 0.15), hf_share(sb, 0.15),
            ("%.2f" % slope(cb)) if slope(cb) else "-",
            ("%.2f" % slope(sb)) if slope(sb) else "-"))
    print()
    for name, path in CASES:
        try:
            a = m.content_crop(path)
        except FileNotFoundError:
            continue
        cb, sb = bands(a)
        print("%-12s speckle_peaks %5d   wedge %s" % (name, speckle_count(sb), wedge(sb)))
