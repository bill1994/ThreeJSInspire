"""Repeatability gate for the capture protocol.

Two independent page loads of the same state must produce byte-identical PNGs.
Anything less means the capture is still carrying wall-clock or layout drift,
and every frame-level metric measured from it is suspect.

Usage:
  python artifacts/cloud-audit/protocol/compare_repeats.py            # all pending pairs
  python artifacts/cloud-audit/protocol/compare_repeats.py A.png B.png # one explicit pair
"""
import glob
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))


def load(path):
    return np.asarray(Image.open(path).convert("RGB")).astype(np.int16)


def compare(a, b):
    A, B = load(a), load(b)
    if A.shape != B.shape:
        return {"identical": False, "reason": "size mismatch %s vs %s" % (A.shape, B.shape)}
    d = np.abs(A - B)
    return {
        "identical": bool(np.array_equal(A, B)),
        "meanAbsDiff": round(float(d.mean()), 6),
        "maxDiff": int(d.max()),
        "changedPixelShare": round(float((d.max(-1) > 2).mean()), 6),
    }


def main():
    if len(sys.argv) == 3:
        pairs = [(sys.argv[1], sys.argv[2])]
    else:
        base = sorted(glob.glob(os.path.join(HERE, "*.png")))
        repeats = [p for p in base if p.endswith(".repeat.png")]
        pairs = [(r.replace(".repeat.png", ".png"), r) for r in repeats]
        if not pairs:
            print("no *.repeat.png pairs found in", HERE)
            return 1

    failures = 0
    for a, b in pairs:
        r = compare(a, b)
        ok = r.get("identical", False)
        failures += 0 if ok else 1
        print("%-42s %s  %s" % (os.path.basename(a), "PASS" if ok else "FAIL",
                                "" if ok else r))
    print()
    print("gate: %d/%d byte-identical" % (len(pairs) - failures, len(pairs)))
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
