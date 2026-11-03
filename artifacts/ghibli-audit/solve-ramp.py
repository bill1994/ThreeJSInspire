"""Solve the four puff band colours from the *rendered* target values.

Chain in this project (`post.ts` + `renderer.ts`):
    material linear -> bloom(>0.82 only) -> DOF -> NeutralToneMapping -> sRGB encode

NeutralToneMapping (three r186, tonemapping_pars_fragment.glsl.js:170):
    x      = min(color)
    offset = x < 0.08 ? x - 6.25*x*x : 0.04
    color -= offset
    if max < 0.76: return color          <- identity apart from that offset

Inverse is a fixed point: after the subtraction the new minimum is `min(r)`, and the
offset is a function of the *original* minimum, so `x = min(r) + offset(x)`; iterate.
Using a flat +0.04 on dark, saturated colours is wrong by several L* (the quadratic
branch lifts them), which is how a ramp can be "solved" and still land off target.

Anchoring (measured, see probe-frame.py on audit-puff-a.png):
    sky beside the shot     L* 68 .. 72   (horizon glow, warm b* +40)
    near sea                L* 17 .. 20
    current puff cloud      L* 17 .. 32   <- four bands squeezed into the dark end

Ghibli's rule is even spacing (measured steps 5.9 / 7.8 / 8.9, mean 7.53). Its absolute
levels belong to foliage. A sunset cloud must stay under the horizon glow and above the
water, so the ramp is re-anchored in that window with the reference's step.
"""

from statistics import mean

# ---------------------------------------------------------------- colour maths


def srgb_to_linear(v: float) -> float:
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def linear_to_srgb(v: float) -> float:
    v = min(max(v, 0.0), 1.0)
    return v * 12.92 if v <= 0.0031308 else 1.055 * (v ** (1 / 2.4)) - 0.055


def f(t: float) -> float:
    return t ** (1 / 3) if t > 216 / 24389 else (841 / 108) * t + 4 / 29


def f_inv(t: float) -> float:
    return t ** 3 if t ** 3 > 216 / 24389 else (t - 4 / 29) * 108 / 841


WHITE = (0.95047, 1.0, 1.08883)


def rgb_to_lab(rgb):
    r, g, b = (srgb_to_linear(c) for c in rgb)
    x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b
    y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b
    fx, fy, fz = f(x / WHITE[0]), f(y / WHITE[1]), f(z / WHITE[2])
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def lab_to_rgb(lab):
    l, a, b = lab
    fy = (l + 16) / 116
    x, y, z = f_inv(fy + a / 500) * WHITE[0], f_inv(fy) * WHITE[1], f_inv(fy - b / 200) * WHITE[2]
    r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z
    g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z
    bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z
    return tuple(linear_to_srgb(v) for v in (r, g, bl))


def lstar_of_linear(lin):
    r, g, b = (min(max(v, 0.0), 1.0) for v in lin)
    y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    return 116 * f(y / WHITE[1]) - 16


# ---------------------------------------------------------------- the plan

SKY = 70.0
SEA = 19.0
STEP = 7.5                       # ghibli mean step, measured
TOP = 60.0                       # 10 below the horizon glow: still a silhouette
TARGETS = [TOP - STEP * i for i in range(3, -1, -1)]

print(f"window      : sea {SEA:.0f} < cloud < sky {SKY:.0f}")
print(f"targets     : {[round(t,1) for t in TARGETS]}")
print(f"steps       : {[round(TARGETS[i+1]-TARGETS[i],1) for i in range(3)]}  mean {STEP}")
print(f"vs current  : darkest was 17, brightest 32 (span 15, all in the dark end)")

# Hue family: violet shadow -> violet base -> rose -> warm light.
ANCHORS = [0x2B1E4E, 0x402D68, 0xDE80AC, 0xEEB3BA]
anchor_lab = [rgb_to_lab(((h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255)) for h in ANCHORS]


def chroma_for(index, target_l):
    """Keep the anchor's hue, take as much chroma as the sRGB gamut allows there."""
    _, a, b = anchor_lab[index]
    scale = 1.0
    for _ in range(80):
        rgb = lab_to_rgb((target_l, a * scale, b * scale))
        if all(0.0 <= c <= 1.0 for c in rgb):
            return a * scale, b * scale
        scale *= 0.95
    return 0.0, 0.0


def offset_of(x):
    return x - 6.25 * x * x if x < 0.08 else 0.04


def invert_neutral(r_lin):
    lo = min(r_lin)
    x = lo
    for _ in range(60):
        x = lo + offset_of(x)
    return [v + offset_of(x) for v in r_lin]


print("\nband  target L*  material hex   peak   branch       compressed?")
hexes = []
for i, t in enumerate(TARGETS):
    a, b = chroma_for(i, t)
    r_lin = [srgb_to_linear(c) for c in lab_to_rgb((t, a, b))]
    c = invert_neutral(r_lin)
    peak = max(c)
    hexed = tuple(round(linear_to_srgb(v) * 255) for v in c)
    hexes.append(hexed)
    branch = "quadratic" if min(c) < 0.08 else "flat 0.04"
    print(
        f"  {i}   {t:6.1f}   #{hexed[0]:02X}{hexed[1]:02X}{hexed[2]:02X}"
        f"   {peak:5.3f}  {branch:10s} {'CLIPPED' if peak >= 0.76 else 'no'}"
    )

print("\nPUFF_BAND_COLORS = [" + ", ".join(f"0x{h[0]:02X}{h[1]:02X}{h[2]:02X}" for h in hexes) + "]")

print("\nround trip through the real tone map:")
got = []
for hexed, t in zip(hexes, TARGETS):
    c = [srgb_to_linear(v / 255) for v in hexed]
    x = min(c)
    r = [max(0.0, v - offset_of(x)) for v in c]
    l = lstar_of_linear(r)
    got.append(l)
    print(f"  #{hexed[0]:02X}{hexed[1]:02X}{hexed[2]:02X} -> L* {l:5.1f}  (target {t:5.1f}, err {l - t:+.1f})")

print(f"\nrendered span  : {max(got) - min(got):.1f} L*   (ghibli reference 22.6)")
print(f"rendered steps : {[round(got[i+1] - got[i], 1) for i in range(3)]}")
print(f"gap to sky     : {SKY - max(got):.1f} L*   gap to sea: {min(got) - SEA:.1f} L*")
print(f"mean |err|     : {mean(abs(g - t) for g, t in zip(got, TARGETS)):.2f} L*")
