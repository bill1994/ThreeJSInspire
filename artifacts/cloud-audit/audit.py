"""One command for every number the audit documents quote.

Before this file there were six re-run commands with three different region
definitions, two of which read a `live/` directory that is not in the repo and one
of which needed scipy, which the documented environment does not have. Reading the
table was easy; knowing whether it was measuring anything was not.

Usage
  python artifacts/cloud-audit/audit.py                 full report
  python artifacts/cloud-audit/audit.py --state A-cruise one state
  python artifacts/cloud-audit/audit.py --json out.json  machine-readable
  python artifacts/cloud-audit/audit.py --parity         gate: exit 1 on any drift

Sections
  states   which frames exist, which can be trusted (gated = second load present)
  gap      reference vs capture, content-anchored regions (horizon split + cloud mask)
  score    the four visual-scorecard signals
  sky      sky-dome bands: strip vs full band, so HUD text is not counted as sky detail
  noise    high-frequency share, spectral slope, speckle peaks, flat wedge
  parity   every pinned value in protocol/baseline-content-anchored.json, re-measured

`--parity` compares 102 pinned numbers at 1e-6. It is the only thing standing between
"the numbers still mean what they meant" and "someone quietly changed a region
definition". Run it before quoting any of this.
"""
import argparse
import importlib.util
import json
import os
import sys

try:
    import numpy  # noqa: F401
    from PIL import Image  # noqa: F401
except ImportError as exc:
    sys.exit("missing dependency '%s' — install with: python -m pip install -r "
             "artifacts/cloud-audit/requirements.txt" % exc.name)

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, fname):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, fname))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


m = _load("m", "ref_gap_measure.py")
st = _load("st", "states.py")
pr = _load("pr", "ref_gap_protocol.py")
sm = _load("sm", "scorecard_metrics.py")
na = _load("na", "noise_audit.py")
sk = _load("sk", "sky_band_probe.py")

BLOCKS = ("tone", "sky", "cloud", "sea")


# --- collection ---------------------------------------------------------------

def pair_rows(state_id=None):
    return [p for p in st.pairs() if not state_id or p["state"] == state_id]


def selected_states(state_id=None):
    return [st.get(state_id)] if state_id else st.states()


def case_paths(state_id=None):
    out = [(p["pair"], st.path(p["ref"])) for p in pair_rows(state_id)]
    out += [(s["state"], st.path(s["capture"])) for s in selected_states(state_id)]
    return out


def collect(state_id=None):
    pairs = []
    for p in pair_rows(state_id):
        pairs.append({
            "pair": p["pair"],
            "state": p["state"],
            "gated": st.gated(p),
            "ref": pr.measure(st.path(p["ref"])),
            "live": pr.measure(st.path(p["capture"])),
        })
    score, noise, sky = [], [], []
    for label, path in case_paths(state_id):
        a = m.content_crop(path)
        score.append({"case": label, "metrics": sm.metrics(a)})
        sky.append({"case": label, "metrics": sk.sky_report(a)})
        cloud, sea = na.bands(a)
        noise.append({
            "case": label,
            "cloud_hf": round(na.hf_share(cloud, 0.15), 3),
            "sea_hf": round(na.hf_share(sea, 0.15), 3) if sea.size else None,
            "cloud_slope": None if na.slope(cloud) is None else round(na.slope(cloud), 2),
            "sea_slope": None if na.slope(sea) is None else round(na.slope(sea), 2),
            "speckle_peaks": na.speckle_count(sea) if sea.size else None,
            "wedge": na.wedge(sea) if sea.size else None,
        })
    return {
        "generated_by": "artifacts/cloud-audit/audit.py",
        "region": "content-anchored (horizon split + cloud mask)",
        "states": st.describe(),
        "missing_files": st.missing_files(),
        "pairs": pairs,
        "scorecard": score,
        "sky": sky,
        "noise": noise,
    }


# Tolerance groups by DIMENSION, not by line (2026-11-08 day-night Task 8): the
# old 1e-6 "equality" was an LSB masquerade — PNG resampling alone moves a share
# by more than that. L*/C* medians move in perceptual units (0.5), share-like
# ratios at 1%, booleans and row counts must match exactly.
L_C_KEYS = {("tone", "median_L"), ("tone", "median_C")}
EXACT_KEYS = {("cloud", "blobs"), ("sea", "rows")}


def _tolerance(block, key, want):
    if not isinstance(want, bool) and isinstance(want, (int, float)):
        if (block, key) in L_C_KEYS:
            return 0.5
        if (block, key) in EXACT_KEYS:
            return None
        return 0.01
    return None


def parity(baseline_path=None):
    """Re-measure every pinned value and compare, matched by PAIR NAME.

    Positional zip compared away pair additions and removals and only iterated the
    NEW keys, so a renamed region or a new metric silently left the gate. Key-set
    and pair-set equality are asserted loudly here: when they drift, regenerate
    the WHOLE baseline (audit.py --json), never pin per-value (there is no tool
    path for that).
    """
    base = json.load(open(baseline_path or st.BASELINE, encoding="utf-8"))
    data = pr.run()
    base_pairs = {p["pair"]: p for p in base["pairs"]}
    new_pairs = {p["pair"]: p for p in data["pairs"]}
    if set(base_pairs) != set(new_pairs):
        raise SystemExit(
            "parity: pair sets differ — baseline-only %s, measured-only %s; "
            "regenerate the whole baseline with audit.py --json, never pin per-value"
            % (sorted(set(base_pairs) - set(new_pairs)), sorted(set(new_pairs) - set(base_pairs)))
        )
    bad, n = [], 0
    for name in sorted(new_pairs):
        old, new = base_pairs[name], new_pairs[name]
        if old.get("state") != new.get("state"):
            raise SystemExit("parity: pair %s changed state (%r -> %r)" % (name, old.get("state"), new.get("state")))
        for side in ("ref", "live"):
            for block in BLOCKS:
                b_block, n_block = old[side][block], new[side][block]
                if set(b_block) != set(n_block):
                    raise SystemExit(
                        "parity: key set drift in %s/%s/%s — baseline %s vs measured %s"
                        % (name, side, block, sorted(b_block), sorted(n_block))
                    )
                for key in sorted(n_block):
                    want = n_block[key]
                    got = b_block[key]
                    n += 1
                    tol = _tolerance(block, key, want)
                    if tol is None:
                        ok = got == want
                    else:
                        ok = isinstance(got, (int, float)) and abs(got - want) <= tol
                    if not ok:
                        bad.append({"pair": name, "side": side, "block": block,
                                    "metric": key, "baseline": got, "measured": want,
                                    "tolerance": tol})
    return n, bad


def night_parity():
    """Gate protocol/night-baseline.json against the night states' captures.

    The night states have no reference artwork, so they never join `pairs`; their
    pin lives in its own baseline keyed by state, compared with the SAME
    dimension-grouped tolerances as the day gate. Format:
    {"generated_by", "region", "states": {"N-dusk": {tone, sky, cloud, sea}, ...}}
    """
    base = json.load(open(st.NIGHT_BASELINE, encoding="utf-8"))
    base_states = base["states"]
    new_states = {s["state"]: pr.measure(st.path(s["capture"])) for s in st.night_states()}
    if set(base_states) != set(new_states):
        raise SystemExit(
            "night parity: state sets differ — baseline %s vs measured %s; "
            "regenerate the whole night baseline, never pin per-value"
            % (sorted(set(base_states) - set(new_states)), sorted(set(new_states) - set(base_states)))
        )
    bad, n = [], 0
    for name in sorted(new_states):
        for block in BLOCKS:
            b_block, n_block = base_states[name][block], new_states[name][block]
            if set(b_block) != set(n_block):
                raise SystemExit("night parity: key set drift in %s/%s" % (name, block))
            for key in sorted(n_block):
                want = n_block[key]
                got = b_block[key]
                n += 1
                tol = _tolerance(block, key, want)
                if tol is None:
                    ok = got == want
                else:
                    ok = isinstance(got, (int, float)) and abs(got - want) <= tol
                if not ok:
                    bad.append({"pair": name, "side": "-", "block": block,
                                "metric": key, "baseline": got, "measured": want,
                                "tolerance": tol})
    return n, bad


# --- printing -----------------------------------------------------------------

def fmt(v):
    if v is None:
        return "-"
    if isinstance(v, bool):
        return "yes" if v else "NO"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return v
    return "%.4g" % v


def print_states(data):
    print("== states")
    for r in data["states"]:
        print("  %-11s alt %-4s gated %-4s %s"
              % (r["state"], r["alt"], "yes" if r["gated"] else "no", r["capture"]))
        if not r["gated"] and r["repeat_missing"]:
            print("  %-11s   gate: %s" % ("", r["repeat_missing"]))
    for miss in data["missing_files"]:
        print("  MISSING %-11s %-8s %s" % (miss["state"], miss["kind"], miss["path"]))
    print()


def print_gap(data):
    print("== reference vs capture (content-anchored)")
    for row in data["pairs"]:
        print("  %s  vs  %s   gated=%s"
              % (row["pair"], row["state"], "yes" if row["gated"] else "no"))
        for block in BLOCKS:
            r, l = row["ref"][block], row["live"][block]
            keys = [k for k in r if k in l and not isinstance(r[k], dict)]
            for key in keys:
                rv, lv = r[key], l[key]
                delta = ""
                if isinstance(rv, (int, float)) and isinstance(lv, (int, float)) \
                        and not isinstance(rv, bool):
                    delta = "%+9.4g" % (lv - rv)
                print("    %-6s %-22s ref %9s   live %9s   %s"
                      % (block, key, fmt(rv), fmt(lv), delta))
            if block == "sea":
                for side, mate in (("ref", r), ("live", l)):
                    if mate.get("usable") is False:
                        print("    %-6s %-22s %s UNUSABLE: %s"
                              % ("", "", side, mate.get("reason")))
        print()


def print_score(data):
    print("== visual scorecard (thresholds: entropy<3.0, dominant>0.6, edges<0.04, contrast<60)")
    print("  %-22s %10s %10s %10s %12s"
          % ("case", "entropy", "domShare", "edgeDens", "contrast"))
    for row in data["scorecard"]:
        r = row["metrics"]
        print("  %-22s %10.2f %10.3f %10.4f %12.1f"
              % (row["case"], r["colorEntropyBits"], r["dominantColorShare"],
                 r["edgeDensity"], r["luminance_contrast"]))
    print()


def print_sky(data):
    print("== sky dome (strip x 0.36..0.56 avoids HUD text; full band includes it)")
    print("  %-22s %10s %11s %9s %11s %8s"
          % ("case", "edge_full", "edge_strip", "sat_strip", "C_med_strip", "steps"))
    for row in data["sky"]:
        r = row["metrics"]
        print("  %-22s %10.4f %11.4f %9.3f %11.1f %8s"
              % (row["case"], r["edge_full"], r["edge_strip"], r["sat_strip"],
                 r["C_med_strip"], fmt(r["row_tonal_steps"])))
    print()


def print_noise(data):
    print("== noise / structure")
    print("  %-22s %9s %9s %11s %11s %7s" % ("case", "cloudHF", "seaHF",
                                             "cloudSlope", "seaSlope", "speckle"))
    for row in data["noise"]:
        print("  %-22s %9s %9s %11s %11s %7s"
              % (row["case"], fmt(row["cloud_hf"]), fmt(row["sea_hf"]),
                 fmt(row["cloud_slope"]), fmt(row["sea_slope"]), fmt(row["speckle_peaks"])))
    for row in data["noise"]:
        if row["wedge"]:
            w = row["wedge"]
            print("  wedge %-16s share %s  bbox %sx%s  std in/out %s/%s"
                  % (row["case"], fmt(w.get("share_of_sea", w.get("share"))),
                     fmt(w.get("bbox_h_frac")), fmt(w.get("bbox_w_frac")),
                     fmt(w.get("std_inside")), fmt(w.get("std_outside"))))
    print()


def print_parity(n, bad, gate, label="protocol/baseline-content-anchored.json"):
    print("== parity vs %s" % label)
    if not bad:
        print("  PASS  %d pinned values, 0 mismatches (dimension-grouped tolerances)" % n)
        return
    print("  FAIL  %d pinned values, %d mismatches" % (n, len(bad)))
    for row in bad:
        print("    %-22s %-4s %-6s %-22s baseline %r  measured %r  tol %r"
              % (row["pair"], row["side"], row["block"], row["metric"],
                 row["baseline"], row["measured"], row["tolerance"]))
    if gate:
        print("  Region definitions moved. Do not quote this table until it passes.")


# --- main ---------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description="one entry point for the cloud-audit numbers")
    ap.add_argument("--state", help="limit to one state (A-cruise, B-dive, C-bankdive, D-skim)")
    ap.add_argument("--json", dest="json_path", help="write the full report as JSON")
    ap.add_argument("--parity", action="store_true",
                    help="run the baseline gate; exit 1 on any drift")
    ap.add_argument("--baseline", help="baseline JSON to gate against "
                    "(default protocol/baseline-content-anchored.json)")
    ap.add_argument("--night-baseline", action="store_true",
                    help="also gate protocol/night-baseline.json (the night states); "
                    "exit 1 on drift — without this gate the night pin has no keeper")
    args = ap.parse_args(argv)

    data = collect(args.state)
    print_states(data)
    if data["pairs"]:
        print_gap(data)
    print_score(data)
    print_sky(data)
    print_noise(data)

    baseline_path = args.baseline or st.BASELINE

    # The JSON lands BEFORE the gate runs: regenerating a stale baseline is the
    # whole-file workflow (day-night plan Task 8 Step 2 ④) and the gate raises
    # SystemExit on key-set/pair-set drift — the report must survive that.
    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1, ensure_ascii=False)

    n, bad = parity(baseline_path)
    print_parity(n, bad, args.parity, os.path.relpath(baseline_path, HERE))

    night_bad = []
    if args.night_baseline:
        nn, night_bad = night_parity()
        print_parity(nn, night_bad, args.night_baseline,
                     os.path.relpath(st.NIGHT_BASELINE, HERE))

    if args.json_path:
        data["parity"] = {"compared": n, "mismatches": bad}
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1, ensure_ascii=False)
        print("\nwritten", args.json_path)

    if args.parity and bad:
        return 1
    if args.night_baseline and night_bad:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
