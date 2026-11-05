"""How much of the sea spectrum can the mesh actually carry?

The sea has three different resolution budgets and the plan (sea note 1.5) only
compared two of them:

  texture  short domain is N=128 over 400 m  -> 3.125 m texel -> Nyquist 6.25 m
  mesh     SEA_PATCH_SIZE 1600 / SEGMENTS 280 -> 5.714 m vertex -> Nyquist 11.43 m
  finest   short domain nyquistGuard 0.85 -> 400 / (0.85*64) = 7.35 m

So the finest represented wave (7.35 m) is 2.35 samples/wavelength in the
texture but only 1.29 samples/wavelength on the mesh. The shading follows a
finer field than the silhouette does: that mismatch, not noise, is what makes
the near field read as sliding plates.

This script splits the realized height and slope variance by wavelength band so
the fix can be chosen on numbers instead of taste:

  (a) refine the mesh until it resolves the represented band, or
  (b) stop representing the band the mesh cannot carry.

Run: python artifacts/cloud-audit/sea_mesh_band.py
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from recompute_sea_bands import (  # noqa: E402
    AMPLITUDE,
    N,
    SEED,
    SEED_SALT_LONG,
    SPLIT,
    build_spec,
    evolve,
)

# Mirrors src/sea-fft.ts and src/palettes.ts. Keep in step with the shader.
SHORT_PATCH = 400.0
SHORT_WIND = 6.4
LONG_PATCH = 2048.0
LONG_WIND = 17.0
NYQ_GUARD = 0.85
MESH_SIZE = 1600.0
MESH_SEGMENTS = 280

SEGMENT_LADDER = (280, 320, 360, 435, 560, 800)


def finest_wavelength(patch, n=N, guard=NYQ_GUARD):
    """Shortest represented wave: the largest ring of bins the guard admits."""
    return patch / (n / 2 * guard)


def mesh_wavelength(segments, size=MESH_SIZE):
    """Shortest wave a vertex grid of `segments` can carry (2 samples per wave)."""
    return 2.0 * size / segments


def index_magnitude(n=N):
    """|bin| index per mode, in cycles across the patch."""
    i = np.arange(n)
    m = np.where(i <= n / 2, i, i - n)
    mx, mz = np.meshgrid(m, m)
    return np.hypot(mx, mz)


def band_rms(re, im, omega, patch, lam_cut):
    """RMS height of the modes with wavelength >= lam_cut, and of those below it.

    The mask depends only on |bin|, so it is symmetric under k -> -k and the two
    reconstructions are exactly orthogonal: var(all) = var(keep) + var(cut).
    """
    mag = index_magnitude()
    keep = mag <= (patch / lam_cut)

    h_all = np.real(np.fft.ifft2(evolve(re, im, omega, 0.0)))
    h_keep = np.real(np.fft.ifft2(evolve(re * keep, im * keep, omega, 0.0)))
    h_cut = h_all - h_keep
    return (
        float(np.sqrt(np.mean(h_keep * h_keep))),
        float(np.sqrt(np.mean(h_cut * h_cut))),
        float(np.sqrt(np.mean(h_all * h_all))),
    )


def band_gradient(re, im, omega, patch, lam_cut):
    """RMS surface slope (m/m) above and below the cut wavelength."""
    mag = index_magnitude()
    keep = mag <= (patch / lam_cut)
    dx = patch / re.shape[0]

    def slope_of(k_re, k_im):
        h = np.real(np.fft.ifft2(evolve(k_re, k_im, omega, 0.0)))
        gx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) / (2 * dx)
        gz = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) / (2 * dx)
        return float(np.sqrt(np.mean(gx * gx + gz * gz)))

    return (
        slope_of(re * keep, im * keep),
        slope_of(re * (1 - keep), im * (1 - keep)),
        slope_of(re, im),
    )


def share(keep, cut):
    total = keep * keep + cut * cut
    return 0.0 if total <= 0 else (keep * keep) / total


def main():
    a_short = AMPLITUDE * np.sqrt(SPLIT)
    a_long = AMPLITUDE * np.sqrt(1 - SPLIT)
    re_s, im_s, w_s = build_spec(N, SHORT_PATCH, SHORT_WIND, a_short, SEED)
    re_l, im_l, w_l = build_spec(N, LONG_PATCH, LONG_WIND, a_long, SEED ^ SEED_SALT_LONG)

    lam_short = finest_wavelength(SHORT_PATCH)
    lam_long = finest_wavelength(LONG_PATCH)
    lam_mesh = mesh_wavelength(MESH_SEGMENTS)

    print("== budgets")
    print("  short domain band      %.2f m .. %.2f m" % (lam_short, SHORT_PATCH))
    print("  long  domain band      %.2f m .. %.2f m" % (lam_long, LONG_PATCH))
    print("  texture texel          %.4f m  -> Nyquist %.2f m" % (SHORT_PATCH / N, 2 * SHORT_PATCH / N))
    print("  mesh  vertex           %.4f m  -> Nyquist %.2f m" % (MESH_SIZE / MESH_SEGMENTS, lam_mesh))
    print("  samples/wl, texture    %.2f" % (lam_short / (SHORT_PATCH / N)))
    print("  samples/wl, mesh       %.2f" % (lam_short / (MESH_SIZE / MESH_SEGMENTS)))
    print()

    print("== short domain split at the mesh Nyquist (%.2f m)" % lam_mesh)
    hs_k, hs_c, hs_a = band_rms(re_s, im_s, w_s, SHORT_PATCH, lam_mesh)
    gs_k, gs_c, gs_a = band_gradient(re_s, im_s, w_s, SHORT_PATCH, lam_mesh)
    print("  height RMS resolved    %.4f m" % hs_k)
    print("  height RMS aliased     %.4f m" % hs_c)
    print("  height RMS total       %.4f m" % hs_a)
    print("  height variance share  %.4f resolved / %.4f aliased" % (share(hs_k, hs_c), share(hs_c, hs_k)))
    print("  slope  RMS resolved    %.5f" % gs_k)
    print("  slope  RMS aliased     %.5f" % gs_c)
    print("  slope  RMS total       %.5f" % gs_a)
    print("  slope  variance share  %.4f resolved / %.4f aliased" % (share(gs_k, gs_c), share(gs_c, gs_k)))
    print()

    print("== long domain split at the mesh Nyquist (%.2f m)" % lam_mesh)
    hl_k, hl_c, hl_a = band_rms(re_l, im_l, w_l, LONG_PATCH, lam_mesh)
    gl_k, gl_c, gl_a = band_gradient(re_l, im_l, w_l, LONG_PATCH, lam_mesh)
    print("  height RMS resolved    %.4f m   aliased %.4f m   total %.4f m" % (hl_k, hl_c, hl_a))
    print("  slope  RMS resolved    %.5f     aliased %.5f     total %.5f" % (gl_k, gl_c, gl_a))
    print()

    print("== segment ladder (short domain only; long domain is fully resolved)")
    print("  segments  vertex m  Nyquist m  s/wl  height kept  slope kept")
    for seg in SEGMENT_LADDER:
        lam = mesh_wavelength(seg)
        hk, hc, _ = band_rms(re_s, im_s, w_s, SHORT_PATCH, lam)
        gk, gc, _ = band_gradient(re_s, im_s, w_s, SHORT_PATCH, lam)
        print(
            "  %8d  %8.3f  %9.2f  %4.2f     %.3f        %.3f"
            % (seg, MESH_SIZE / seg, lam, lam_short / (MESH_SIZE / seg), share(hk, hc), share(gk, gc))
        )
    print()

    print("== what each mesh can carry, as a quantile of the combined surface")
    h_all = np.real(np.fft.ifft2(evolve(re_s, im_s, w_s, 0.0))) + np.real(
        np.fft.ifft2(evolve(re_l, im_l, w_l, 0.0))
    )
    mag = index_magnitude()
    print("  full field height p1/p50/p99  %.4f / %.4f / %.4f m" % tuple(
        np.percentile(h_all, [1, 50, 99])
    ))
    for seg in (MESH_SEGMENTS, 435, 560):
        lam = mesh_wavelength(seg)
        keep = mag <= (SHORT_PATCH / lam)
        h_geo = np.real(np.fft.ifft2(evolve(re_s * keep, im_s * keep, w_s, 0.0))) + np.real(
            np.fft.ifft2(evolve(re_l, im_l, w_l, 0.0))
        )
        print(
            "  %3d segments: geometry height p1/p50/p99  %.4f / %.4f / %.4f m   (sigma %.4f vs %.4f)"
            % (seg, *np.percentile(h_geo, [1, 50, 99]), np.std(h_geo), np.std(h_all))
        )


if __name__ == "__main__":
    main()
