"""CPU recomputation of the sea shader's toon bands, from the same deterministic field.

Why: `sea-fft.ts` builds a Phillips spectrum with a fixed seed, so the height field,
the normals and every band weight in the TSL graph are reproducible off-GPU. This
script re-implements `buildPhillipsSpectrum` / `evolveTo` / `fft2d` / `seaSurface`
(rng = mulberry32 + Box-Muller pairs, exactly the call order in the TS) and then
applies the *shader* arithmetic from `createTslSeaMaterial`:

    hNorm = clamp(h * 0.62 + 0.5, 0, 1)
    shape = clamp(hNorm * 0.62 + ndl * 0.38, 0, 1)
    lit   = smoothstep(0.54, 0.88, shape)
    crest = smoothstep(0.88, 1.00, shape) * 0.45
    facetSlope = clamp((1 - ny) / 0.30, 0, 1)
    specExponent = mix(96, 26, facetSlope)

Two domains, variance-split 0.6 / 0.4, exactly as `applyTexture` does.

Known deviation: the shader's metre-scale `mx_noise` bump on the normal is skipped
(it is a small additive derivative term, faded out with distance). Every number
below is therefore marked as a recomputation, not a rendered measurement.

Usage: python artifacts/cloud-audit/recompute_sea_bands.py
"""
import numpy as np

# mulberry32 relies on 32-bit wraparound; the overflow warnings are the intended
# modular arithmetic, not a bug.
np.seterr(over="ignore")

G = 9.81
SEED = 1337
AMPLITUDE = 0.34
SPLIT = 0.6
N = 128
SUN_POSITION = (60.0, 35.0, -280.0)
NYQ_GUARD = 0.85
EXAGG = 1.4


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


def build_spec(n, patch, wind, amp, seed):
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
        f = np.sqrt(-2 * np.log(s) / s)
        spare[0] = v * f
        return u * f

    re = np.zeros((n, n))
    im = np.zeros((n, n))
    omega = np.zeros((n, n))
    kscale = 2 * np.pi / patch
    L = wind * wind / G
    small = 0.06 * L
    nyq = (n / 2) * NYQ_GUARD
    wx, wz = 0.82, -0.57
    wl = np.hypot(wx, wz)
    wx, wz = wx / wl, wz / wl

    for zi in range(n):
        mz = zi if zi <= n / 2 else zi - n
        for xi in range(n):
            mx = xi if xi <= n / 2 else xi - n
            kx, kz = mx * kscale, mz * kscale
            k = np.hypot(kx, kz)
            if k < 1e-6:
                continue
            if abs(mx) > nyq or abs(mz) > nyq:
                continue
            omega[zi, xi] = np.sqrt(G * k)
            kdl = k * L
            p = np.exp(-1.0 / (kdl * kdl)) / (k ** 4)
            kl = k * small
            p *= np.exp(-kl * kl)
            dir_dot = (kx / k) * wx + (kz / k) * wz
            if dir_dot <= 0:
                continue
            p *= dir_dot * dir_dot
            mag = np.sqrt(p) * np.sqrt(0.5)
            if not (mag > 0) or not np.isfinite(mag):
                continue
            re[zi, xi] = mag * gauss()
            im[zi, xi] = mag * gauss()

    # outlier clamp (8 sigma of the RMS mode magnitude)
    mean_sq = (re * re + im * im).mean()
    rms_mag = np.sqrt(mean_sq)
    if rms_mag > 0:
        clamp = rms_mag * 8
        mag = np.hypot(re, im)
        over = mag > clamp
        scale = np.where(over, clamp / np.maximum(mag, 1e-30), 1.0)
        re *= scale
        im *= scale

    # evolve to t=0 and measure the RMS height, then normalise to `amp`
    h0 = evolve(re, im, omega, 0.0)
    h = np.real(np.fft.ifft2(h0))
    rms = np.sqrt(np.mean(h * h))
    scale = amp / rms if rms > 1e-6 else 1.0
    return re * scale, im * scale, omega


def evolve(re, im, omega, t):
    """h(k,t) = h0(k) e^{iwt} + conj(h0(-k)) e^{-iwt}."""
    n = re.shape[0]
    flipped = np.conj(re[::-1, ::-1] + 1j * im[::-1, ::-1])
    ang = omega * t
    e = np.exp(1j * ang)
    return (re + 1j * im) * e + flipped * np.conj(e)


def surface(re, im, omega, patch):
    n = re.shape[0]
    h = np.real(np.fft.ifft2(evolve(re, im, omega, 0.0)))
    dx = patch / n
    inv2dx = 1 / (2 * dx)
    gx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * inv2dx * EXAGG
    gz = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * inv2dx * EXAGG
    length = np.sqrt(gx * gx + 1 + gz * gz)
    return h, -gx / length, -gz / length


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def main():
    a_short = AMPLITUDE * np.sqrt(SPLIT)
    a_long = AMPLITUDE * np.sqrt(1 - SPLIT)

    re_s, im_s, w_s = build_spec(N, 400.0, 6.4, a_short, SEED)
    re_l, im_l, w_l = build_spec(N, 2048.0, 17.0, a_long, SEED)

    hs, nxs, nzs = surface(re_s, im_s, w_s, 400.0)
    hl, nxl, nzl = surface(re_l, im_l, w_l, 2048.0)

    total = hs + hl
    nx = nxs + nxl
    nz = nzs + nzl
    ny = np.sqrt(np.maximum(1 - (nx * nx + nz * nz), 0.02))
    nrm = np.sqrt(nx * nx + ny * ny + nz * nz)
    nxu, nyu, nzu = nx / nrm, ny / nrm, nz / nrm

    sun = np.array(SUN_POSITION, dtype=float)
    sun /= np.linalg.norm(sun)
    ndl = np.clip(nxu * sun[0] + nyu * sun[1] + nzu * sun[2], 0, 1)

    h_norm = np.clip(total * 0.62 + 0.5, 0, 1)
    shape = np.clip(h_norm * 0.62 + ndl * 0.38, 0, 1)
    lit = smoothstep(0.54, 0.88, shape)
    crest = smoothstep(0.88, 1.0, shape) * 0.45

    slope = np.clip((1 - nyu) / 0.30, 0, 1)
    exponent = 96 + (26 - 96) * slope

    def q(a, ps=(1, 5, 50, 95, 99, 100)):
        return {f"p{p}": round(float(np.percentile(a, p)), 4) for p in ps}

    print("sun elevation (deg): %.2f" % np.degrees(np.arcsin(sun[1])))
    print("field RMS height (m): %.4f  (target %.2f)" % (np.sqrt(np.mean(total ** 2)), AMPLITUDE))
    print()
    print("total height  ", q(total))
    print("normal.y      ", q(nyu))
    print("1 - normal.y  ", q(1 - nyu))
    print("ndl           ", q(ndl))
    print("hNorm         ", q(h_norm))
    print("shape         ", q(shape))
    print("lit weight    ", q(lit))
    print("crest weight  ", q(crest))
    print("facetSlope    ", q(slope))
    print("specExponent  ", q(exponent, (1, 5, 50, 95, 100)))
    print()
    print("area share shape >= 0.54 (lit band start): %.4f" % float((shape >= 0.54).mean()))
    print("area share shape >= 0.88 (crest band start): %.6f" % float((shape >= 0.88).mean()))
    print("area share lit  > 0.5 : %.4f" % float((lit > 0.5).mean()))
    print("area share crest > 0.0: %.6f  max %.6f" % (float((crest > 0.0).mean()), float(crest.max())))
    print("area share facetSlope >= 0.5 (exp <= 61): %.4f" % float((slope >= 0.5).mean()))
    print("area share facetSlope >= 1.0 (exp == 26): %.6f" % float((slope >= 1.0).mean()))
    print()
    print("depth/mid mix at shape=0.35 (deep->mid weight): %.3f" % float(smoothstep(0.14, 0.56, 0.35)))
    print("deep/mid weight p50: %.3f  p95: %.3f" % (
        float(np.median(smoothstep(0.14, 0.56, shape))),
        float(np.percentile(smoothstep(0.14, 0.56, shape), 95))))


if __name__ == "__main__":
    main()
