#!/usr/bin/env python3
"""Tell Waypoint that a plan-editing run has finished.

    python3 signal.py apply_finished --changed
    python3 signal.py update_finished --plan add-auth.md --no-changed

Writes `.waypoint/signals/<slug>.json`, which the extension watches. The viewer
stops its "Writing v<n>…" spinner the moment the file appears, instead of
inferring completion from plan-file writes and a quiet window.

That inference is why this exists: a run that correctly changes nothing writes
nothing, so the viewer could not tell "no change needed" from a dead agent and
sat spinning until a timeout. `--changed` / `--no-changed` is the bit no file
watcher can observe.

This is a signal, not a gate (#D10). Forgetting it costs the reviewer a wait —
the extension's own timers still end the spinner — but never correctness, and
never a wrong plan.
"""

import argparse
import json
import os
import sys
import time

EVENTS = ("apply_finished", "update_finished")


def fail(msg):
    print("signal: " + msg, file=sys.stderr)
    sys.exit(1)


def default_plans_dir():
    """`.waypoint/plans`, or the pre-rename `.galley/plans` when only that
    exists, so workspaces initialized before the rename keep working."""
    for root in (".waypoint", ".galley"):
        d = os.path.join(root, "plans")
        if os.path.isdir(d):
            return d
    return os.path.join(".waypoint", "plans")


def resolve_plan(arg):
    """The plan this signal is about. Mirrors tick.py's resolution exactly, so
    the two scripts never disagree about what "the current plan" means."""
    plans_dir = default_plans_dir()
    if arg:
        for cand in (arg, os.path.join(plans_dir, arg), os.path.join(plans_dir, arg + ".md")):
            if os.path.isfile(cand):
                return cand
        fail("no plan named %r (tried it as a path and under %s/)" % (arg, plans_dir))
    if not os.path.isdir(plans_dir):
        fail("no %s/ here — run from the repo root" % plans_dir)
    cands = [
        os.path.join(plans_dir, n)
        for n in os.listdir(plans_dir)
        if n.endswith(".md")
        and not n.endswith(".review.md")
        and os.path.isfile(os.path.join(plans_dir, n))
    ]
    if not cands:
        fail("no plans in %s/" % plans_dir)
    return max(cands, key=lambda p: os.stat(p).st_mtime)


def waypoint_dir(plan_path):
    """`.waypoint/` (or the pre-rename `.galley/`) from the plan's own path,
    so the signal lands beside the plan it describes rather than beside the cwd."""
    return os.path.dirname(os.path.dirname(os.path.abspath(plan_path)))


def main():
    ap = argparse.ArgumentParser(
        description="Signal Waypoint that a plan-editing run has finished."
    )
    ap.add_argument("event", choices=EVENTS)
    ap.add_argument("--plan", help="plan slug or path (default: newest non-review plan)")
    changed = ap.add_mutually_exclusive_group(required=True)
    changed.add_argument(
        "--changed", dest="changed", action="store_true",
        help="the run rewrote the plan",
    )
    changed.add_argument(
        "--no-changed", dest="changed", action="store_false",
        help="the run read the plan and concluded no change was needed",
    )
    args = ap.parse_args()

    plan_path = resolve_plan(args.plan)
    plan = os.path.basename(plan_path)
    signals = os.path.join(waypoint_dir(plan_path), "signals")
    os.makedirs(signals, exist_ok=True)

    # Slug, not filename: one signal per plan, so a stale one is overwritten
    # rather than accumulating a queue the extension would have to reconcile.
    slug = plan[:-3] if plan.endswith(".md") else plan
    path = os.path.join(signals, slug + ".json")
    payload = {
        "event": args.event,
        "plan": plan,
        "changed": bool(args.changed),
        "ts": int(time.time() * 1000),
    }
    # Write whole then rename: the extension deletes the file as it reads it, so
    # a half-written one would be consumed as a truncated JSON parse error.
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
        f.write("\n")
    os.replace(tmp, path)
    print("signal: %s %s (changed=%s)" % (args.event, plan, payload["changed"]))


if __name__ == "__main__":
    main()
