"""Quantify the value span of the two 4-colour toon ramps.

Claim under audit: "the puff material now reads like the ghibli reference".
The structural part (4 hard steps) can be true while the *ramp* is not: ghibli's
four greens are all mid-tones, so the plateaus separate by hue/value steps of
roughly one L* decade. Our sunset palette spans shadow -> near-white.

Native domain: CIE L* from sRGB hex. Units: L* (0..100). No renderer involved.
"""

def lstar(hex_rgb: int) -> float:
    r = (hex_rgb >> 16) & 0xFF
    g = (hex_rgb >> 8) & 0xFF
    b = hex_rgb & 0xFF

    def chan(v: int) -> float:
        s = v / 255.0
        return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4

    y = 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
    return 116 * (y ** (1 / 3)) - 16


def lightness(hex_rgb: int) -> float:
    r = (hex_rgb >> 16) & 0xFF
    g = (hex_rgb >> 8) & 0xFF
    b = hex_rgb & 0xFF
    mx, mn = max(r, g, b), min(r, g, b)
    return 0.0 if mx == 0 else (mx - mn) / mx


GHIBLI = [0x427062, 0x33594E, 0x234549, 0x1E363F]          # Trees.jsx set #1, bright -> dark
OURS = [0x2B1E4E, 0x402D68, 0xDE80AC, 0xFFE6C8]            # shadow, base, pink, gold
OURS_TOP = [0x2B1E4E, 0x402D68, 0xDE80AC, 0xEEB3BA]        # after the pink/gold top blend

def report(name: str, ramp: list[int]) -> None:
    ls = [lstar(h) for h in ramp]
    sat = [lightness(h) for h in ramp]
    steps = [abs(ls[i] - ls[i + 1]) for i in range(len(ls) - 1)]
    print(f"\n{name}")
    for h, l, s in zip(ramp, ls, sat):
        print(f"  #{h:06X}  L*={l:6.2f}  HSV-S={s:4.2f}")
    print(f"  span        = {max(ls) - min(ls):6.2f} L*")
    print(f"  darkest     = {min(ls):6.2f} L*")
    print(f"  brightest   = {max(ls):6.2f} L*")
    print(f"  mean step   = {sum(steps) / len(steps):6.2f} L*")
    print(f"  steps       = {[round(s, 1) for s in steps]}")

report("GHIBLI reference ramp", GHIBLI)
report("OURS (current)", OURS)
report("OURS (pink/gold top blend)", OURS_TOP)

g_span = max(lstar(h) for h in GHIBLI) - min(lstar(h) for h in GHIBLI)
o_span = max(lstar(h) for h in OURS_TOP) - min(lstar(h) for h in OURS_TOP)
print(f"\nspan ratio ours/ghibli = {o_span / g_span:.2f}x")
print(f"darkest contrast       = {min(lstar(h) for h in OURS_TOP) - min(lstar(h) for h in GHIBLI):+.1f} L* (negative = we are darker)")
print(f"brightest contrast     = {max(lstar(h) for h in OURS_TOP) - max(lstar(h) for h in GHIBLI):+.1f} L* (positive = we are brighter)")
