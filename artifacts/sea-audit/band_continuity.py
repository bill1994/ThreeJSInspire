"""Band-occupancy metrics for a rendered sea frame. **PNG mode only.**

```
python artifacts/sea-audit/band_continuity.py <shot.png> --mpp 0.4 --wind-screen dx dy
```

One JSON object on stdout: edge coherence/curvature/spacing, band occupancy,
and the classification's own validity fraction.

## What this is for

The gate it still serves is the stylized-sea Task 7 one: the four palette bands
must each own more than 5% of the sea pixels (the FFT/FBM era failed that gate
with crest at 0.1%). `occupancy` and `occupancyFromRawClassification` are the
numbers for that gate. The edge shape metrics are legacy-shaped — they were
designed to describe a band-*index* field, and the current shading cuts its
bands from a per-fragment height ramp, so read them as relative between two
captures, never as absolute truth about the shader.

## What this is NOT

It does not rebuild the shader field on the CPU any more. The `--recompute`
mode mirrored `sea-fft.ts`'s Phillips spectrum and `SEA_BAND_STOPS`, and that
whole implementation was deleted on `reconstruct` (`f9a73d5`), together with
its numpy mirror `recompute_sea_bands.py` and the TS metric core
`src/sea-metrics.ts`. Recomputing it here would produce confident numbers about
a shader that no longer exists. If you ever need that math back, it is in git:
`git show 4d7f6d3~:artifacts/sea-audit/band_continuity.py`.

## Reading the PNG mode

Perspective squashes distant bands toward the horizon, so the world wind
direction must be projected first — pass `--wind-screen dx dy` in image
coordinates (y down), from the camera yaw or by clicking two band-edge points.
`--mpp` is metres per pixel at the measured depth; every metric with `_m` in
its name is scaled by it.

`PALETTE` below is copied from `src/palettes.ts` `SEA_PALETTE`; the first four
entries are the bands. If the palette is re-graded (Task 7 does exactly that),
this dict must move with it — a stale palette classifies the whole frame as
"invalid" and reports `validFraction ≈ 0`, which is the failure mode to watch
for rather than trust the occupancy numbers.
"""
import argparse
import json
import math

import numpy as np

np.seterr(over="ignore")

PALETTE = {              # SEA_PALETTE (palettes.ts:91-108); first four = bands
    "deep": (0x32, 0x2C, 0x58),
    "mid": (0x4A, 0x42, 0x72),
    "lit": (0xB1, 0x78, 0x8A),
    "crest": (0xFF, 0xD6, 0xA8),
    "glitter": (0xFF, 0xF2, 0xD6),
    "foam": (0xFF, 0xF0, 0xE2),
    "haze": (0xFF, 0x9A, 0x5A),
}


# ---------------------------------------------------------------------------
# Metric core — frozen formulas, no live TS counterpart since `src/sea-metrics.ts`
# was deleted with the FFT sea. Do not chase parity with a module that is gone.
# ---------------------------------------------------------------------------
def _median(values):
    if len(values) == 0:
        return 0.0
    s = np.sort(np.asarray(values))
    mid = len(s) // 2
    return float(s[mid]) if len(s) % 2 == 1 else float((s[mid - 1] + s[mid]) / 2)


def metrics_from_field(field, stops, wind, mpp, top_stop, scanlines=64):
    """Band metrics on a level field. field[j, i]: j = z/row, i = x/col.

    Formerly a mirror of `bandMetrics()` in the deleted `src/sea-metrics.ts`;
    this is now the only implementation, frozen.
    """
    H, W = field.shape
    stops = tuple(float(s) for s in stops)
    assert len(stops) == 3
    wl = math.hypot(*wind)
    wx, wz = wind[0] / wl, wind[1] / wl
    # World step between adjacent pixels (matches the TS grid convention).
    step_x = mpp  # metres per pixel along x (columns)
    step_z = mpp  # metres per pixel along z (rows)

    gy, gx = np.gradient(field)  # gy = dF/drow(z), gx = dF/dcol(x)
    gx = gx / step_x
    gy = gy / step_z
    glen = np.hypot(gx, gy)
    valid_g = glen > 1e-12
    nx = np.where(valid_g, gx / np.maximum(glen, 1e-30), 0.0)
    nz = np.where(valid_g, gy / np.maximum(glen, 1e-30), 0.0)
    # level-set curvature kappa = -div(normal)
    dnx_x = np.gradient(nx, axis=1) / step_x
    dnz_z = np.gradient(nz, axis=0) / step_z
    kappa = np.abs(dnx_x + dnz_z)

    def crosses(a, b):
        return any((a - s) * (b - s) < 0 for s in stops)

    edge = np.zeros((H, W), dtype=bool)
    for stop in stops:
        horiz = (field[:, :-1] - stop) * (field[:, 1:] - stop) < 0
        vert = (field[:-1, :] - stop) * (field[1:, :] - stop) < 0
        edge[:, :-1] |= horiz
        edge[:, 1:] |= horiz
        edge[:-1, :] |= vert
        edge[1:, :] |= vert

    theta = np.arctan2(gx, -gy)  # tangent = gradient rotated 90deg, as in the TS
    edge_valid = edge & valid_g
    if edge_valid.any():
        c2 = np.cos(2 * theta)[edge_valid].sum()
        s2 = np.sin(2 * theta)[edge_valid].sum()
        coherence = float(np.hypot(c2, s2) / edge_valid.sum())
        curvature = float(kappa[edge_valid & (kappa > 0)].mean()) if (kappa[edge_valid] > 0).any() else 0.0
    else:
        coherence = 0.0
        curvature = 0.0

    # occupancy
    occ = [
        float((field < stops[0]).mean()),
        float(((field >= stops[0]) & (field < stops[1])).mean()),
        float(((field >= stops[1]) & (field < stops[2])).mean()),
        float((field >= stops[2]).mean()),
    ]

    # top-band components (8-connected BFS)
    mask = field > top_stop
    visited = np.zeros_like(mask, dtype=bool)
    count = 0
    extent_sum = 0.0
    xs = (np.arange(W) - (W - 1) / 2) * step_x
    zs = (np.arange(H) - (H - 1) / 2) * step_z
    X, Z = np.meshgrid(xs, zs)
    A = X * wx + Z * wz
    for j0 in range(H):
        for i0 in range(W):
            if visited[j0, i0] or not mask[j0, i0]:
                continue
            count += 1
            stack = [(j0, i0)]
            visited[j0, i0] = True
            a_min, a_max = math.inf, -math.inf
            while stack:
                j, i = stack.pop()
                a = A[j, i]
                a_min = min(a_min, a)
                a_max = max(a_max, a)
                for dj in (-1, 0, 1):
                    jj = j + dj
                    if jj < 0 or jj >= H:
                        continue
                    for di in (-1, 0, 1):
                        ii = i + di
                        if ii < 0 or ii >= W:
                            continue
                        if not visited[jj, ii] and mask[jj, ii]:
                            visited[jj, ii] = True
                            stack.append((jj, ii))
            extent_sum += a_max - a_min
    area_100 = (W * step_x) * (H * step_z) / 100.0
    components = count / area_100 if area_100 > 0 else 0.0
    extent_along = extent_sum / count if count else 0.0

    # edge spacing: scanlines perpendicular to the wind (across-band profile)
    qx, qz = -wz, wx

    def bil(xw, zw):
        # world metres -> pixel coords
        px = xw / step_x + (W - 1) / 2
        pz = zw / step_z + (H - 1) / 2
        px = min(max(px, 0), W - 1)
        pz = min(max(pz, 0), H - 1)
        i0, j0 = int(px), int(pz)
        i1, j1 = min(i0 + 1, W - 1), min(j0 + 1, H - 1)
        fx, fz = px - i0, pz - j0
        return (
            field[j0, i0] * (1 - fx) * (1 - fz)
            + field[j0, i1] * fx * (1 - fz)
            + field[j1, i0] * (1 - fx) * fz
            + field[j1, i1] * fx * fz
        )

    gaps = []
    diag = math.hypot((W - 1) * step_x, (H - 1) * step_z)
    n_scan_pts = max(2, int(diag / (mpp / 2)))
    scan_step = diag / n_scan_pts
    for k in range(scanlines):
        s = -diag / 2 + (k + 0.5) * diag / scanlines
        prev = bil(wx * s + qx * (-diag / 2), wz * s + qz * (-diag / 2))
        crossings = []
        for m in range(1, n_scan_pts + 1):
            t = -diag / 2 + m * scan_step
            v = bil(wx * s + qx * t, wz * s + qz * t)
            for stop in stops:
                if (prev - stop) * (v - stop) < 0:
                    frac = (stop - prev) / (v - prev)
                    crossings.append(t - scan_step + frac * scan_step)
            prev = v
        gaps.extend(crossings[m] - crossings[m - 1] for m in range(1, len(crossings)))

    return {
        "edgeCoherence": round(coherence, 4),
        "componentsPer100m2": round(components, 4),
        "extentAlongWind_m": round(extent_along, 2),
        "edgeCurvature_per_m": round(curvature, 6),
        "edgeSpacing_m": round(_median(gaps), 3),
        "occupancy": [round(v, 4) for v in occ],
    }


# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------

def kmeans4(img_f, iters=12):
    """Four-cluster k-means; returns cluster id per pixel sorted dark->bright."""
    H, W, _ = img_f.shape
    pts = img_f.reshape(-1, 3)
    rng = np.random.default_rng(7)
    centers = pts[rng.choice(pts.shape[0], 4, replace=False)].copy()
    for _ in range(iters):
        d = ((pts[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
        assign = d.argmin(axis=1)
        for k in range(4):
            mask = assign == k
            if mask.any():
                centers[k] = pts[mask].mean(axis=0)
    d = ((pts[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
    assign = d.argmin(axis=1).reshape(H, W)
    lum = centers.mean(axis=1)
    order = np.argsort(lum)  # dark -> bright = deep -> crest
    remap = np.empty(4, dtype=np.int32)
    for rank, old_id in enumerate(order):
        remap[old_id] = rank
    return remap[assign]


def mode_png(args):
    from PIL import Image

    img = np.asarray(Image.open(args.png).convert("RGB"), dtype=np.int32)
    if args.max_size and max(img.shape[:2]) > args.max_size:
        scale = args.max_size / max(img.shape[:2])
        img = img[
            :: max(1, int(1 / scale)), :: max(1, int(1 / scale))
        ]
    band_keys = ("deep", "mid", "lit", "crest")
    # reject colours: glitter/foam/haze sit close to band colours in the tonemapped
    # frame; without them the sun-road dashes and foam classify as lit/crest and
    # their edges drown the band-field signal (measured: coherence 0.35 for BOTH
    # backends before this fix).
    if args.palette_mode == "kmeans":
        # The final/debug frame goes through ACES tonemapping, which compresses
        # the dark band colours together — absolute palette matching then
        # collapses most of the sea into "deep" and the "edges" become
        # classification noise (measured: both backends ~0.34 with edge spacing
        # ~2 px). Cluster the sea region on its OWN colours instead and map the
        # clusters dark->bright onto deep..crest.
        #
        # Pre-trim: the capture may pillarbox the canvas with uniform bars
        # (measured: 65% of the frame width) and the sky steals the brightest
        # cluster — trim uniform columns/rows, keep only the bottom
        # --bottom-frac of what remains, then k-means k=4.
        col_std = img.astype(np.float64).std(axis=(0, 2))
        row_std = img.astype(np.float64).std(axis=(1, 2))
        # pillarbox bars are near-uniform (measured std ~13 vs content ~70);
        # trim the contiguous low-std runs at both edges
        def trim_runs(stds, total, thresh):
            lo = 0
            while lo < total // 2 and stds[lo] < thresh:
                lo += 1
            hi = total
            while hi > total // 2 and stds[hi - 1] < thresh:
                hi -= 1
            return lo, hi
        c0, c1 = trim_runs(col_std, img.shape[1], 40)
        r0, r1 = trim_runs(row_std, img.shape[0], 40)
        sea_r0 = int(r0 + (r1 - r0) * (1 - args.bottom_frac))
        crop = img[sea_r0:r1, c0:c1, :].astype(np.float64)
        band_crop = kmeans4(crop)
        band = np.full(img.shape[:2], -1, dtype=np.int32)
        band[sea_r0:r1, c0:c1] = band_crop
        valid = band >= 0
    else:
        pal = np.array([PALETTE[k] for k in band_keys] + [PALETTE["glitter"], PALETTE["foam"], PALETTE["haze"]], dtype=np.int32)
        d = np.linalg.norm(img[:, :, None, :] - pal[None, None, :, :], axis=3)
        nearest = d.argmin(axis=2)
        nearest_dist = d.min(axis=2)
        valid = (nearest < 4) & (nearest_dist < args.tolerance)
        band = np.where(valid, nearest, -1)

    # continuous proxy: fill invalid with nearest valid band, then blur so the
    # gradient/curvature machinery sees a smooth field. Boundaries of the proxy
    # sit at 0.5/1.5/2.5 regardless of the palette's actual stop values.
    proxy = band.astype(float)
    missing = band < 0
    if missing.any():
        # iteratively diffuse valid values into the invalid gaps
        for _ in range(64):
            if not (proxy < 0).any():
                break
            padded = np.pad(proxy, 1, mode="edge")
            neigh = (
                padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:]
            ) / 4.0
            proxy = np.where(proxy < 0, neigh, proxy)
        proxy = np.where(np.isnan(proxy), 1.0, proxy)
    for _ in range(args.blur):
        padded = np.pad(proxy, 1, mode="edge")
        proxy = (
            padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:]
        ) / 4.0

    wl = math.hypot(*args.wind_screen)
    m = metrics_from_field(
        proxy,
        (0.5, 1.5, 2.5),
        args.wind_screen,
        args.mpp,
        top_stop=args.top_stop + 0.5,
        scanlines=args.scanlines,
    )
    # occupancy from the raw classification (valid pixels only)
    valid_frac = valid.mean()
    occ_raw = [(band == b).sum() / max(valid.sum(), 1) for b in range(4)]
    m["mode"] = "png"
    m["png"] = args.png
    m["windScreen"] = list(args.wind_screen)
    m["windScreenNormalized"] = [round(args.wind_screen[0] / wl, 4), round(args.wind_screen[1] / wl, 4)]
    m["mpp"] = args.mpp
    m["paletteTolerance"] = args.tolerance
    m["validFraction"] = round(float(valid_frac), 4)
    m["occupancyFromRawClassification"] = [round(v, 4) for v in occ_raw]
    return m


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("png", nargs="?", help="rendered screenshot to measure")
    ap.add_argument("--top-stop", type=int, default=2,
                    help="index of the proxy level treated as the top band (0..2)")
    ap.add_argument("--wind-screen", type=float, nargs=2, default=(1.0, 0.0), metavar=("DX", "DY"),
                    help="screen-space wind direction (image coords, y down)")
    ap.add_argument("--mpp", type=float, default=1.0, help="metres per pixel at the measured depth")
    ap.add_argument("--tolerance", type=float, default=45.0, help="max RGB distance to a palette colour")
    ap.add_argument("--blur", type=int, default=3, help="blur passes on the band-index proxy")
    ap.add_argument("--scanlines", type=int, default=64)
    ap.add_argument("--max-size", type=int, default=0, help="downscale if the longest side exceeds this (0 = off)")
    ap.add_argument("--palette-mode", choices=("kmeans", "fixed"), default="kmeans",
                    help="kmeans = cluster the sea region's own colours (tonemap-proof); fixed = absolute SEA_PALETTE match")
    ap.add_argument("--bottom-frac", type=float, default=0.5,
                    help="fraction of the frame height (from the bottom) treated as sea")
    args = ap.parse_args()

    if not args.png:
        ap.error("give a png path")
    print(json.dumps(mode_png(args), indent=2))


if __name__ == "__main__":
    main()
