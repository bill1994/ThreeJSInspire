"""Single source of truth for the audit states.

Every audit script used to carry its own copy of "which reference goes with which
capture": ref_gap_protocol.PAIRS, ref_gap_three.PAIRS, noise_audit.CASES and
scorecard_metrics.CASES. They drifted, and two documented re-run commands ended up
pointing at `artifacts/cloud-audit/live/`, a directory that is not in the repo, so
those commands reported MISSING (or measured nothing) instead of failing loudly.

Read the mapping from here. Paths are absolute, so a script works from any cwd.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
PROTOCOL = os.path.join(HERE, "protocol")

BASE_REF_DIR = "docs/superpowers/specs/assets"
BASE_PROTOCOL_DIR = "artifacts/cloud-audit/protocol"

# `repeat` is the second independent load of the same state used by the capture
# gate. It is None when the repo does not actually contain the file: a gate that
# names a file nobody can read is not a gate.
STATES = [
    {
        "state": "A-cruise",
        "alt": 60,
        "pair": "ref-01 sunset glide",
        "ref": BASE_REF_DIR + "/ref-01-sunset-glide.png",
        "capture": BASE_PROTOCOL_DIR + "/A-cruise-alt60.png",
        "repeat": None,
        "repeat_missing": ("protocol/capture-protocol.json records A-cruise-alt60.repeat.png "
                           "as the byte-identical second load, but that file is not in the repo"),
    },
    {
        "state": "B-dive",
        "alt": 200,
        "pair": "ref-02 speed lines",
        "ref": BASE_REF_DIR + "/ref-02-speed-lines.png",
        "capture": BASE_PROTOCOL_DIR + "/B-dive-alt200.png",
        "repeat": None,
        "repeat_missing": "no second load was recorded for this state",
    },
    {
        "state": "C-bankdive",
        "alt": 220,
        "pair": "ref-03 spiral dive",
        "ref": BASE_REF_DIR + "/ref-03-spiral-dive.png",
        "capture": BASE_PROTOCOL_DIR + "/C-bankdive-alt220.png",
        "repeat": BASE_PROTOCOL_DIR + "/C-bankdive-alt220.repeat.png",
        "repeat_missing": None,
    },
    {
        "state": "D-skim",
        "alt": 60,
        "pair": None,
        "ref": None,
        "capture": BASE_PROTOCOL_DIR + "/D-skim-alt60.png",
        "repeat": None,
        "repeat_missing": "no second load was recorded for this state",
    },
    # Night keys (2026-11-08 day-night plan Task 8): same machine/alt as A-cruise
    # so the ONLY variable vs A-cruise is the sun elevation. ref is None (no
    # reference artwork for a night sky) — these states are gated by
    # protocol/night-baseline.json via `audit.py --night-baseline`, not by the
    # day baseline.
    {
        "state": "N-dusk",
        "alt": 60,
        "pair": None,
        "ref": None,
        "capture": BASE_PROTOCOL_DIR + "/N-dusk-sun0.png",
        "repeat": BASE_PROTOCOL_DIR + "/N-dusk-sun0.repeat.png",
        "repeat_missing": None,
    },
    {
        "state": "N-civil",
        "alt": 60,
        "pair": None,
        "ref": None,
        "capture": BASE_PROTOCOL_DIR + "/N-civil-sun-4.png",
        "repeat": BASE_PROTOCOL_DIR + "/N-civil-sun-4.repeat.png",
        "repeat_missing": None,
    },
    {
        "state": "N-night",
        "alt": 60,
        "pair": None,
        "ref": None,
        "capture": BASE_PROTOCOL_DIR + "/N-night-sun-8.png",
        "repeat": BASE_PROTOCOL_DIR + "/N-night-sun-8.repeat.png",
        "repeat_missing": None,
    },
]

BASELINE = os.path.join(PROTOCOL, "baseline-content-anchored.json")
NIGHT_BASELINE = os.path.join(PROTOCOL, "night-baseline.json")
CAPTURE_PROTOCOL = os.path.join(PROTOCOL, "capture-protocol.json")


def path(rel):
    """Absolute path for a repo-relative path, or None for None."""
    return None if rel is None else os.path.join(ROOT, rel)


def states():
    return list(STATES)


def night_states():
    """The three night-key states, for the --night-baseline gate."""
    return [s for s in STATES if s["state"].startswith("N-")]


def get(state_id):
    for s in STATES:
        if s["state"] == state_id:
            return s
    raise KeyError(state_id)


def pairs():
    """States that have a reference frame to compare against."""
    return [s for s in STATES if s["ref"]]


def gated(state):
    """True only when the second load actually exists on disk."""
    return bool(state["repeat"]) and os.path.exists(path(state["repeat"]))


def missing_files():
    """Every declared path that is not on disk, with its owner, so a re-run fails loud."""
    out = []
    for s in STATES:
        for key in ("ref", "capture", "repeat"):
            rel = s[key]
            if rel and not os.path.exists(path(rel)):
                out.append({"state": s["state"], "kind": key, "path": rel})
    return out


def describe():
    rows = []
    for s in STATES:
        rows.append({
            "state": s["state"],
            "alt": s["alt"],
            "pair": s["pair"],
            "capture": s["capture"],
            "capture_present": os.path.exists(path(s["capture"])),
            "gated": gated(s),
            "repeat_missing": s["repeat_missing"],
        })
    return rows


if __name__ == "__main__":
    for r in describe():
        print("%-11s alt %-4s gated %-5s capture %-46s pair %s"
              % (r["state"], r["alt"], r["gated"], r["capture"], r["pair"]))
    for miss in missing_files():
        print("MISSING %-11s %-8s %s" % (miss["state"], miss["kind"], miss["path"]))
