"""Band-continuity metrics for the sea colour bands (plan 2026-11-03, Task 0).

Two modes:

1. `--recompute` — rebuild the *current* shader band field on the CPU from the
   deterministic Phillips spectrum (mirror of `sea-fft.ts` @ 6e8c56b: cos^12
   directional spectrum, texel-unit ridge in the texture alpha, two cascades
   2048/400 m, shape = 0.5 + 0.15*ridge + 0.038*(hNorm-0.5), SEA_BAND_STOPS
   0.44/0.56/0.68) and measure it. This pins the "how broken is it today"
   baseline into the plan's §3.1 table.

   NOTE: `artifacts/cloud-audit/recompute_sea_bands.py` is stale on both the
   spectrum (cos^2) and the shape formula (height+ndl); its numbers predate
   043b0e9. Do not mix its output with this script's.

2. `png <file>` — classify rendered pixels against SEA_PALETTE's four band
   colours, blur the band index into a continuous proxy, and measure the same
   metrics on screen. The authoritative TS implementation of the metrics is
   `src/sea-metrics.ts`; this file is its numpy mirror for GPU-visible
   artifacts, so the formulas must be kept in step.

Both modes print one JSON object.

The screen-space wind matters in PNG mode: perspective squashes distant bands
toward the horizon, so the world wind direction must be projected first
(pass --wind-screen dx,dy in image coordinates, y down; from the camera yaw or
by clicking two points on a band edge).
"""
import argparse
import json
import math

import numpy as np

np.seterr(over="ignore")

# ---------------------------------------------------------------------------
# Current-shader constants (keep in step with src/sea-fft.ts / src/palettes.ts)
# ---------------------------------------------------------------------------
G = 9.81
SEED = 1337
SALT_LONG = 0x5BD1E995
AMPLITUDE = 0.34
NYQUIST_GUARD = 0.85
NORMAL_EXAGGERATION = 1.4  # normals are not used by the band field; kept for parity
FFT_N = 128
CASCADES = [  # (patch_m, wind_ms, seed_salt, variance_weight) == SEA_CASCADES
    (2048.0, 17.0, SALT_LONG, 0.4),
    (400.0, 6.4, 0x00000000, 0.6),
]
DIRECTION_EXPONENT = 12  # cos^12, sea-fft.ts:286
RIDGE_SCALE = 0.15       # SEA_SHAPE.ridgeScale
WEIGHT_HEIGHT = 0.38     # SEA_SHAPE.weightHeight
SEA_BAND_STOPS = (0.44, 0.56, 0.68)
WIND = (0.82, -0.57)     # DEFAULT_SEA.windDirection
PALETTE = {              # SEA_PALETTE band colours (palettes.ts:91-108)
    "deep": (0x32, 0x2C, 0x58),
    "mid": (0x4A, 0x42, 0x72),
    "lit": (0xB1, 0x78, 0x8A),
    "crest": (0xFF, 0xD6, 0xA8),
}


# ---------------------------------------------------------------------------
# Deterministic spectrum mirror (mulberry32 + Box-Muller pairs, call order
# identical to buildPhillipsSpectrum)
# ---------------------------------------------------------------------------
def mulberry32(seed):
    a = seed & 0xFFFFFFFF

    def rnd():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = (np.int64(t ^ (t >> 15)) * np.int64(t | 1)) & 0xFFFFFFFF
        t ^= (t + (np.int64(t ^ (t >> 7)) * np.int64(t | 61))) & 0xFFFFFFFF
        t &= 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rnd


def build_spec(n, patch, wind_speed, amp, seed):
    rnd = mulberry32(seed)
    spare = [None]

    def gauss():
        if spare[0] is not None:
            s = spare[0]
            spare[0] = None
            return s
        while True:
            u = rnd() * 2 - 1
            v = rnd() * 2 - 1
            s = u * u + v * v
            if s != 0 and s < 1:
                break
        f = math.sqrt(-2 * math.log(s) / s)
        spare[0] = v * f
        return u * f

    re = np.zeros((n, n))
    im = np.zeros((n, n))
    omega = np.zeros((n, n))
    kscale = 2 * math.pi / patch
    L = wind_speed * wind_speed / G
    small = 0.06 * L
    nyq = (n / 2) * NYQUIST_GUARD
    wl = math.hypot(*WIND)
    wx, wz = WIND[0] / wl, WIND[1] / wl

    for zi in range(n):
        mz = zi if zi <= n / 2 else zi - n
        for xi in range(n):
            mx = xi if xi <= n / 2 else xi - n
            kx, kz = mx * kscale, mz * kscale
            k = math.hypot(kx, kz)
            if k < 1e-6 or abs(mx) > nyq or abs(mz) > nyq:
                continue
            omega[zi, xi] = math.sqrt(G * k)
            kdl = k * L
            p = math.exp(-1.0 / (kdl * kdl)) / (k ** 4)
            kl = k * small
            p *= math.exp(-kl * kl)
            dir_dot = (kx / k) * wx + (kz / k) * wz
            if dir_dot <= 0:
                continue
            p *= dir_dot ** DIRECTION_EXPONENT
            mag = math.sqrt(p) * math.sqrt(0.5)
            if not (mag > 0) or not math.isfinite(mag):
                continue
            re[zi, xi] = mag * gauss()
            im[zi, xi] = mag * gauss()

    mean_sq = (re * re + im * im).mean()
    rms_mag = math.sqrt(mean_sq)
    if rms_mag > 0:
        clamp = rms_mag * 8
        mag = np.hypot(re, im)
        over = mag > clamp
        scale = np.where(over, clamp / np.maximum(mag, 1e-30), 1.0)
        re *= scale
        im *= scale

    h0 = (re + 1j * im) * np.exp(1j * omega * 0.0) + np.conj(
        (re[::-1, ::-1] + 1j * im[::-1, ::-1])
    )
    h = np.real(np.fft.ifft2(h0))
    rms = math.sqrt((h * h).mean())
    scale = amp / rms if rms > 1e-6 else 1.0
    return re * scale, im * scale, omega


def cascade_fields(patch, wind_speed, amp, seed):
    """Height + texel-unit ridge along the rounded wind texel step (t=0)."""
    re, im, omega = build_spec(FFT_N, patch, wind_speed, amp, seed)
    h = np.real(np.fft.ifft2(re + 1j * im))
    wl = math.hypot(*WIND)
    sx = int(round(WIND[0] / wl))
    sz = int(round(WIND[1] / wl))
    h_plus = np.roll(np.roll(h, -sz, axis=0), -sx, axis=1)
    h_minus = np.roll(np.roll(h, sz, axis=0), sx, axis=1)
    ridge = -(h_plus - 2 * h + h_minus)
    return h, ridge


def bilinear_wrap(field, u, v):
    """Sample a periodic texel grid at fractional texel coordinates u, v (arrays)."""
    n = field.shape[0]
    u = np.mod(u, n)
    v = np.mod(v, n)
    i0 = np.floor(u).astype(int)
    j0 = np.floor(v).astype(int)
    fu = u - i0
    fv = v - j0
    i1 = (i0 + 1) % n
    j1 = (j0 + 1) % n
    return (
        field[j0, i0] * (1 - fu) * (1 - fv)
        + field[j0, i1] * fu * (1 - fv)
        + field[j1, i0] * (1 - fu) * fv
        + field[j1, i1] * fu * fv
    )


def recompute_shape_field(extent, size):
    """The band-driver field the shader sees at t=0, sampled on a world grid.

    Returns (shape, ridge): `shape` is what SEA_BAND_STOPS actually cuts; `ridge`
    is the raw combined curvature field (texel units) whose direction coherence
    the technical note quotes as 0.61.
    """
    wsum = sum(c[3] for c in CASCADES)
    h_sum = np.zeros((size, size))
    ridge_sum = np.zeros((size, size))
    xs = np.linspace(-extent / 2, extent / 2, size)
    X, Z = np.meshgrid(xs, xs)
    for patch, wind, salt, weight in CASCADES:
        amp = AMPLITUDE * math.sqrt(weight / wsum)
        h, ridge = cascade_fields(patch, wind, amp, (SEED ^ int(salt)) & 0xFFFFFFFF)
        h_sum += bilinear_wrap(h, X / patch * FFT_N, Z / patch * FFT_N)
        ridge_sum += bilinear_wrap(ridge, X / patch * FFT_N, Z / patch * FFT_N)
    h_norm = np.clip(h_sum * 0.62 + 0.5, 0, 1)
    shape = np.clip(0.5 + ridge_sum * RIDGE_SCALE + (h_norm - 0.5) * (WEIGHT_HEIGHT * 0.1), 0, 1)
    return shape, ridge_sum


# ---------------------------------------------------------------------------
# Metric core — numpy mirror of src/sea-metrics.ts (keep the formulas in step)
# ---------------------------------------------------------------------------
def _median(values):
    if len(values) == 0:
        return 0.0
    s = np.sort(np.asarray(values))
    mid = len(s) // 2
    return float(s[mid]) if len(s) % 2 == 1 else float((s[mid - 1] + s[mid]) / 2)


def metrics_from_field(field, stops, wind, mpp, top_stop, scanlines=64):
    """Mirror of bandMetrics() in src/sea-metrics.ts. field[j, i]: j = z/row, i = x/col."""
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
def mode_recompute(args):
    shape, ridge = recompute_shape_field(args.extent, args.size)
    if args.field == "ridge":
        # raw combined ridge is in arbitrary texel units: cut it at the same
        # quantiles the shader's stops approximate (p25/p75/p97, SEA_BAND_STOPS
        # docstring in sea-fft.ts)
        field = ridge
        stops = tuple(float(np.percentile(ridge, q)) for q in (25, 75, 97))
    else:
        field = shape
        stops = SEA_BAND_STOPS
    top_stop = stops[args.top_stop]
    m = metrics_from_field(
        field, stops, WIND, args.extent / (args.size - 1), top_stop
    )
    m["mode"] = "recompute"
    m["field"] = f"fft {args.field} @ t=0 (cos^12, texel-unit ridge, two cascades)"
    m["stops"] = [round(s, 4) for s in stops]
    m["topStopIndex"] = args.top_stop
    m["extent_m"] = args.extent
    m["grid"] = args.size
    return m


def mode_png(args):
    from PIL import Image

    img = np.asarray(Image.open(args.png).convert("RGB"), dtype=np.int32)
    if args.max_size and max(img.shape[:2]) > args.max_size:
        scale = args.max_size / max(img.shape[:2])
        img = img[
            :: max(1, int(1 / scale)), :: max(1, int(1 / scale))
        ]
    pal = np.array([PALETTE[k] for k in ("deep", "mid", "lit", "crest")], dtype=np.int32)
    # distance of every pixel to every palette colour
    d = np.linalg.norm(img[:, :, None, :] - pal[None, None, :, :], axis=3)
    nearest = d.argmin(axis=2)
    nearest_dist = d.min(axis=2)
    valid = nearest_dist < args.tolerance
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
    ap.add_argument("--recompute", action="store_true", help="measure the CPU-recomputed FFT band field")
    ap.add_argument("--field", choices=("shape", "ridge"), default="shape",
                    help="recompute: which field to measure (ridge = the field the 0.61 note quoted)")
    ap.add_argument("--extent", type=float, default=1024.0, help="recompute: world extent (m)")
    ap.add_argument("--size", type=int, default=512, help="recompute: grid resolution")
    ap.add_argument("--top-stop", type=int, default=2, help="index of the stop defining the top band (0..2)")
    ap.add_argument("--wind-screen", type=float, nargs=2, default=(1.0, 0.0), metavar=("DX", "DY"),
                    help="png: screen-space wind direction (image coords, y down)")
    ap.add_argument("--mpp", type=float, default=1.0, help="png: metres per pixel at the measured depth")
    ap.add_argument("--tolerance", type=float, default=45.0, help="png: max RGB distance to a palette colour")
    ap.add_argument("--blur", type=int, default=3, help="png: blur passes on the band-index proxy")
    ap.add_argument("--scanlines", type=int, default=64)
    ap.add_argument("--max-size", type=int, default=0, help="png: downscale if the longest side exceeds this (0 = off)")
    args = ap.parse_args()

    if args.recompute:
        out = mode_recompute(args)
    elif args.png:
        out = mode_png(args)
    else:
        ap.error("give a png path or --recompute")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
