"""Undo three.js NeutralToneMapping on a captured pixel before comparing it to the palette.

Why this exists
  The sea colour chain (src/sea-fft.ts:699-784) is built only from `mix` and `add`
  over SEA_PALETTE constants, so every rendered pixel must lie inside that palette's
  convex hull — in *scene-linear* space, before the output transform. Handoff §3
  measured linear G 0.0088 on a near-field pixel whose palette minimum is deep's
  0.0252 and concluded the chain had been bypassed somewhere. It had not. The capture
  is sRGB-encoded *post*-tone-map data, and NeutralToneMapping is not a pass-through
  on dark colours:

      x      = min(r, g, b)                       // scene-linear
      offset = x < 0.08 ? x - 6.25 * x * x : 0.04
      color -= offset                              // ...then a shoulder above 0.76

  Subtracting `x` from every channel deletes the minimum channel and leaves
  `6.25 * x * x` in its place. For deep (#322c58, min channel G = 0.0252) that is
  G 0.0252 -> 0.0040, an 84% cut, applied to a pixel that never left the hull.

Method
  The low branch is exactly invertible because the min channel survives as 6.25x^2:

      x             = sqrt(captured_min) / 2.5
      scene_linear  = captured_linear + (x - 6.25 * x * x)

  Above the compression start (peak >= 0.76) the shoulder multiplies and the fold
  becomes non-injective, so `unfold()` reports `invertible=False` instead of guessing.
  Every sea / mid-sky / cloud-shadow pixel is far below 0.76 and takes the exact path.

Usage
  python artifacts/cloud-audit/tonemap_unfold.py artifacts/cloud-audit/protocol-2026-11-01/A-cruise-alt60.png
"""
import importlib.util
import itertools
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

# src/palettes.ts SEA_PALETTE — duplicated on purpose: a measurement must not silently
# follow a palette edit, it must fail loudly when the palette no longer describes the frame.
SEA_PALETTE = {
    "deep": 0x322C58,
    "mid": 0x4A4272,
    "lit": 0xB1788A,
    "crest": 0xFFD6A8,
    "glitter": 0xFFF2D6,
    "foam": 0xFFF0E2,
    "haze": 0xFF9A5A,
}

# SKY_PALETTE plus the two extra SKY_STOPS colours (0.42 -> #c96a8f, 1 -> #4a2f74).
SKY_PALETTE = {
    "top": 0x6B4FA1,
    "horizon": 0xFF9A5A,
    "sun": 0xFFD9A0,
    "stop_0.42": 0xC96A8F,
    "stop_1.0": 0x4A2F74,
    "below_horizon": 0x8C4A5E,
}

CLOUD_PALETTE = {
    "shadow": 0x2B1E4E,
    "base": 0x402D68,
    "pink": 0xDE80AC,
    "gold": 0xFFE6C8,
}

START_COMPRESSION = 0.8 - 0.04
DESATURATION = 0.15


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(lin):
    lin = np.clip(np.asarray(lin, dtype=np.float64), 0.0, 1.0)
    s = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1.0 / 2.4) - 0.055)
    return np.round(s * 255.0)


def palette_linear(hexv):
    return srgb_to_linear(np.array([(hexv >> 16) & 255, (hexv >> 8) & 255, hexv & 255]))


def fold(lin, exposure=1.0):
    """three.js NeutralToneMapping, verbatim (tonemapping_pars_fragment.glsl.js:170-197)."""
    color = np.asarray(lin, dtype=np.float64) * exposure
    x = float(color.min())
    offset = x - 6.25 * x * x if x < 0.08 else 0.04
    color = color - offset
    peak = float(color.max())
    if peak < START_COMPRESSION:
        return color
    d = 1.0 - START_COMPRESSION
    new_peak = 1.0 - d * d / (peak + d - START_COMPRESSION)
    color = color * (new_peak / peak)
    g = 1.0 - 1.0 / (DESATURATION * (peak - new_peak) + 1.0)
    return color * (1.0 - g) + new_peak * g


def unfold(linear_post, exposure=1.0):
    """Returns (scene_linear, invertible). Exact below the compression start, reported otherwise."""
    post = np.asarray(linear_post, dtype=np.float64) / exposure
    x = float(np.sqrt(max(post.min(), 0.0)) / 2.5)
    offset = x - 6.25 * x * x if x < 0.08 else 0.04
    scene = post + offset
    invertible = float(scene.max() * exposure) < START_COMPRESSION
    return scene, invertible


def unfold_many(linear_post):
    """Row-wise `unfold` for a (N, 3) array. Same exact low branch, no per-pixel flip-flop."""
    post = np.clip(np.asarray(linear_post, dtype=np.float64), 0.0, None)
    x = np.sqrt(post.min(axis=-1)) / 2.5
    offset = np.where(x < 0.08, x - 6.25 * x * x, 0.04)
    return post + offset[:, None]


def fold_many(lin):
    """Row-wise `fold` for a (N, 3) array."""
    color = np.array(lin, dtype=np.float64)
    x = color.min(axis=-1)
    offset = np.where(x < 0.08, x - 6.25 * x * x, 0.04)
    color = color - offset[:, None]
    peak = color.max(axis=-1)
    over = peak >= START_COMPRESSION
    d = 1.0 - START_COMPRESSION
    new_peak = np.where(over, 1.0 - d * d / np.where(over, peak + d - START_COMPRESSION, 1.0), peak)
    scale = np.where(over, new_peak / np.where(over, peak, 1.0), 1.0)
    color = color * scale[:, None]
    g = np.where(over, 1.0 - 1.0 / (DESATURATION * (peak - new_peak) + 1.0), 0.0)
    return color * (1.0 - g)[:, None] + new_peak[:, None] * g[:, None]


def frame_stats(path):
    """How much of the finished frame is decided by the tone map rather than by the scene."""
    m = _load("ref_gap_measure")
    a = m.content_crop(path)
    post = srgb_to_linear(a.reshape(-1, 3) * 255.0)
    scene = unfold_many(post)
    x = scene.min(axis=-1)
    peak = scene.max(axis=-1)
    offset_branch = x < 0.08
    exact = peak < START_COMPRESSION
    err = float(np.abs(fold_many(scene[exact]) - post[exact]).max()) if exact.any() else float("nan")
    xb = x[offset_branch]
    print("\n%s  %dx%d" % (os.path.basename(path), a.shape[1], a.shape[0]))
    print("   offset branch (min<0.08): %.1f%%   constant-0.04 branch: %.1f%%"
          % (100.0 * offset_branch.mean(), 100.0 * (~offset_branch).mean()))
    print("   below shoulder (exact)  : %.1f%%   at/above 0.76 (lossy): %.1f%%"
          % (100.0 * exact.mean(), 100.0 * (peak >= START_COMPRESSION).mean()))
    print("   fold(unfold(x)) vs capture, max abs error over %d px: %.2e" % (int(exact.sum()), err))
    if xb.size:
        print("   offset branch min channel: mean %.4f -> %.4f on screen (%.0f%% removed)"
              % (xb.mean(), (6.25 * xb * xb).mean(),
                 100.0 * (1.0 - (6.25 * xb * xb).mean() / xb.mean())))


def preimage(target_srgb):
    """The scene-linear value that *displays* as `target_srgb` under NeutralToneMapping.

    Use this to author against the look instead of against the shader: pick the on-screen
    colour, then write the returned sRGB into src/palettes.ts.
    """
    post = srgb_to_linear(np.asarray(target_srgb, dtype=np.float64))
    scene, invertible = unfold(post)
    return scene, linear_to_srgb(scene), invertible


def palette_drift(palette=SEA_PALETTE, title="SEA_PALETTE"):
    """What each palette entry is authored as, versus what NeutralToneMapping shows."""
    m = _load("ref_gap_measure")
    print("\n%-12s %-15s %-15s %-15s %6s %6s %8s"
          % (title, "authored", "on screen", "to show authored", "dL*", "dC*", "min_lin"))
    for name, hexv in palette.items():
        scene = palette_linear(hexv)
        shown = fold(scene)
        auth_srgb = np.array([(hexv >> 16) & 255, (hexv >> 8) & 255, hexv & 255], dtype=np.float64)
        a_lab = m.srgb_to_lab(auth_srgb[None, :] / 255.0)[0]
        shown_srgb = linear_to_srgb(shown)
        s_lab = m.srgb_to_lab(shown_srgb[None, :] / 255.0)[0]
        a_c = float(np.hypot(a_lab[1], a_lab[2]))
        s_c = float(np.hypot(s_lab[1], s_lab[2]))
        need = preimage(auth_srgb)[1]
        print("  %-11s rgb(%3.0f,%3.0f,%3.0f) rgb(%3.0f,%3.0f,%3.0f) rgb(%3.0f,%3.0f,%3.0f) %+6.1f %+6.1f   %.4f"
              % (name, auth_srgb[0], auth_srgb[1], auth_srgb[2],
                 shown_srgb[0], shown_srgb[1], shown_srgb[2],
                 need[0], need[1], need[2],
                 s_lab[0] - a_lab[0], s_c - a_c, scene.min()))


def band_fit(path, palette, bands, title):
    """Unfold each band's median, then check whether the palette hull explains it."""
    m = _load("ref_gap_measure")
    a = m.content_crop(path)
    print("\n%s — %s" % (os.path.basename(path), title))
    for name, r0, r1 in bands:
        rgb = sea_bands(a, ((name, r0, r1),))[name]
        post = srgb_to_linear(rgb)
        scene, invertible = unfold(post)
        nn, nw, nres = hull_fit(post, palette)
        fn, fw, fres = hull_fit(scene, palette)
        print("  %-18s sRGB(%3.0f,%3.0f,%3.0f) exact %-5s  raw res %.5f (%s)  unfolded res %.5f (%s %s)"
              % (name, rgb[0], rgb[1], rgb[2], invertible, nres, "+".join(nn), fres,
                 "+".join(fn), np.array2string(fw, precision=2)))


def affine_weights(entries, pixel):
    """Least squares over the affine hull of `entries` (weights sum to 1), negatives dropped.

    Returns one weight per entry in the original order; a dropped entry keeps 0.
    """
    all_idx = list(range(len(entries)))
    idx = list(all_idx)
    while True:
        A = np.stack([entries[i] for i in idx], axis=1)          # 3 x k
        k = A.shape[1]
        ata = A.T @ A
        kkt = np.zeros((k + 1, k + 1))
        kkt[:k, :k] = ata
        kkt[:k, k] = 1.0
        kkt[k, :k] = 1.0
        rhs = np.zeros(k + 1)
        rhs[:k] = A.T @ pixel
        rhs[k] = 1.0
        try:
            sol = np.linalg.solve(kkt, rhs)[:k]
        except np.linalg.LinAlgError:
            return None
        if sol.min() >= -1e-9 or len(idx) == 1:
            sol = np.clip(sol, 0.0, None)
            sol = sol / sol.sum()
            full = np.zeros(len(all_idx))
            for slot, i in enumerate(idx):
                full[i] = sol[slot]
            return full
        idx.pop(int(np.argmin(sol)))


def hull_fit(pixel, palette, max_entries=3):
    """Closest point to `pixel` inside the convex hull of `palette`.

    Returns (names, weights, residual). A residual at float noise level means the pixel
    is an exact mix of the named palette entries; a large residual means something
    outside the palette produced it (or the comparison was made in the wrong space).
    """
    entries = [palette_linear(palette[n]) for n in palette]
    names = list(palette)
    best = (None, None, float("inf"))
    for k in range(1, max_entries + 1):
        for combo in itertools.combinations(range(len(names)), k):
            w = affine_weights([entries[i] for i in combo], pixel)
            if w is None:
                continue
            cand = np.stack([entries[i] for i in combo], axis=1) @ w
            res = float(np.linalg.norm(cand - pixel))
            if res < best[2]:
                used = w > 1e-6
                best = ([names[combo[i]] for i in range(k) if used[i]], w[used], res)
    return best


def sea_bands(a, fractions):
    h = a.shape[0]
    out = {}
    for name, r0, r1 in fractions:
        band = a[int(h * r0):int(h * r1)].reshape(-1, 3)
        out[name] = np.median(band, axis=0) * 255.0
    return out


BANDS = (("near bottom 4%", 0.960, 1.000),
         ("near rows 88-92%", 0.880, 0.920),
         ("mid rows 66-72%", 0.660, 0.720),
         ("sky rows 6-12%", 0.060, 0.120))


def report(path):
    m = _load("ref_gap_measure")
    a = m.content_crop(path)
    print("\n%s  crop %dx%d" % (os.path.basename(path), a.shape[1], a.shape[0]))
    for name, rgb in sea_bands(a, BANDS).items():
        post = srgb_to_linear(rgb)
        scene, invertible = unfold(post)
        nn, nw, nres = hull_fit(post, SEA_PALETTE)
        fn, fw, fres = hull_fit(scene, SEA_PALETTE)
        check = linear_to_srgb(fold(scene))
        print("  %-18s sRGB(%3.0f,%3.0f,%3.0f)  invertible %-5s"
              % (name, rgb[0], rgb[1], rgb[2], invertible))
        print("     raw pixel     fit %-16s w=%-14s residual %.5f"
              % ("+".join(nn), np.array2string(nw, precision=2), nres))
        print("     unfolded      fit %-16s w=%-14s residual %.5f  fold-back sRGB(%3.0f,%3.0f,%3.0f)"
              % ("+".join(fn), np.array2string(fw, precision=2), fres, check[0], check[1], check[2]))


SKY_BANDS = (("sky rows 0-6%", 0.000, 0.060),
             ("sky rows 12-22%", 0.120, 0.220),
             ("sky rows 30-40%", 0.300, 0.400))


def target_report(path):
    """For a reference still: the colours to author so our screen reproduces them.

    A reference image is already on-screen data, so its pixels are the target look. Feed
    them through `preimage` and you get the palette values that *display* as the reference.
    """
    m = _load("ref_gap_measure")
    a = m.content_crop(path)
    print("\n%s  content %dx%d  (target look -> values to author)" % (os.path.basename(path),
          a.shape[1], a.shape[0]))
    for name, rgb in sea_bands(a, BANDS).items():
        need = preimage(rgb)[1]
        print("  %-18s ref sRGB(%3.0f,%3.0f,%3.0f)   author rgb(%3.0f,%3.0f,%3.0f)"
              % (name, rgb[0], rgb[1], rgb[2], need[0], need[1], need[2]))


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--target":
        for p in args[1:]:
            target_report(p if os.path.isabs(p) or os.path.exists(p) else os.path.join(HERE, p))
        sys.exit(0)
    palette_drift(SEA_PALETTE, "SEA_PALETTE")
    palette_drift(SKY_PALETTE, "SKY_PALETTE")
    palette_drift(CLOUD_PALETTE, "CLOUD_PALETTE")
    for p in (args or ["protocol-2026-11-01/A-cruise-alt60.png"]):
        if not os.path.isabs(p) and not os.path.exists(p):
            p = os.path.join(HERE, p)
        report(p)
        frame_stats(p)
        band_fit(p, {**SKY_PALETTE, **CLOUD_PALETTE}, SKY_BANDS, "sky bands vs SKY+CLOUD palette")
