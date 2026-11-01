"""Content-anchored baseline: horizon split + cloud mask instead of 30/62/70% bands.

Everything here is measured on regions the image actually contains, so a pair whose
framing differs from the reference does not silently compare sky against sea. When a
frame has no valid sea line the sea block is reported as null, never guessed.

Usage: python artifacts/cloud-audit/ref_gap_protocol.py
"""
import importlib.util
import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


m = _load("m", os.path.join(HERE, "ref_gap_measure.py"))
cb = _load("cb", os.path.join(HERE, "content_bands.py"))
st = _load("st", os.path.join(HERE, "states.py"))

# The state/ref/capture mapping lives in states.py; this file must not carry a copy.
PAIRS = [(p["pair"], st.path(p["ref"]), p["state"], st.path(p["capture"])) for p in st.pairs()]


def cloud_block(a):
    """Cloud mass over the whole frame: the mask owns its own region."""
    mask = m.cloud_mask(a)
    lab, n = m.ndimage.label(mask)
    areas = m.ndimage.sum(mask, lab, range(1, n + 1))
    big = [i + 1 for i, ar in enumerate(areas) if ar > 0.002 * mask.size]
    h, s, v = m.hsv(a)
    cv = v[mask] if mask.sum() > 500 else None
    out = {
        "coverage": round(float(mask.mean()), 3),
        "blobs": len(big),
        "blob_area_frac_median": None,
        "value_mean": None if cv is None else round(float(cv.mean()), 3),
        "sat_mean": round(float(s[mask].mean()), 3) if cv is not None else None,
    }
    if big:
        out["blob_area_frac_median"] = round(
            float(np.median([areas[i - 1] for i in big]) / mask.size), 4)
    return out


def sea_block(a):
    b = cb.bands(a)
    if b["sea"] is None or b["sea"].size == 0:
        return {"usable": False, "reason": b["reason"]}
    sea = b["sea"]
    lum = sea.mean(-1)
    lap = np.zeros_like(lum)
    lap[1:-1, 1:-1] = (4 * lum[1:-1, 1:-1] - lum[:-2, 1:-1] - lum[2:, 1:-1]
                       - lum[1:-1, :-2] - lum[1:-1, 2:])
    col = lum.mean(axis=0)
    return {
        "usable": True,
        "horizon_frac": b["horizon"] / a.shape[0],
        "sparkle_rel": round(float(np.var(lap) / max(lum.mean(), 1e-6) ** 2), 4),
        "sunroad_ratio": round(float(np.percentile(col, 98) / max(np.median(col), 1e-6)), 2),
        "value_mean": round(float(lum.mean()) / 1.0, 3),
        "rows": int(sea.shape[0]),
    }


def sky_block(a):
    b = cb.bands(a)
    sky = b["sky"]
    h, s, v = m.hsv(sky)
    rows = sky.shape[0]
    top = float(v[: max(1, rows // 4)].mean())
    bottom = float(v[-max(1, rows // 4):].mean())
    return {
        "sat_max": round(float(np.percentile(s, 98)), 3),
        "sat_mean": round(float(s.mean()), 3),
        "value_swing": round(abs(top - bottom), 3),
    }


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


def measure(path):
    a = m.content_crop(path)
    return {"tone": tone(a), "sky": sky_block(a), "cloud": cloud_block(a), "sea": sea_block(a)}


def run():
    rows = []
    for label, ref_p, state, live_p in PAIRS:
        rows.append({"pair": label, "state": state,
                     "ref": measure(ref_p), "live": measure(live_p)})
    return {"generated_by": "artifacts/cloud-audit/ref_gap_protocol.py",
            "region": "content-anchored (horizon split + cloud mask)", "pairs": rows}


if __name__ == "__main__":
    data = run()
    for row in data["pairs"]:
        print("=" * 72)
        print("%s   vs   %s" % (row["pair"], row["state"]))
        for block in ("tone", "sky", "cloud", "sea"):
            r, l = row["ref"][block], row["live"][block]
            keys = [k for k in r if not isinstance(r[k], (dict,)) and k in l]
            for k in keys:
                rv, lv = r[k], l[k]
                if isinstance(rv, (int, float)) and isinstance(lv, (int, float)):
                    print("  %-8s %-20s ref %8.3f   live %8.3f   delta %+8.3f" % (block, k, rv, lv, lv - rv))
                elif rv is None or lv is None:
                    print("  %-8s %-20s ref %8s   live %8s" % (block, k, rv, lv))
            if block == "sea" and not r.get("usable", True):
                print("  sea      ref UNUSABLE: %s" % r.get("reason"))
            if block == "sea" and not l.get("usable", True):
                print("  sea      live UNUSABLE: %s" % l.get("reason"))
        print()
    path = os.path.join(HERE, "protocol", "baseline-content-anchored.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, ensure_ascii=False)
    print("written", path)
