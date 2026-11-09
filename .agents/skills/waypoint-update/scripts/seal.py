#!/usr/bin/env python3
"""Seal the current plan as a version before /waypoint-update rewrites it.

    python3 seal.py --reason "Phase 2 gate C4 failed: the migration needs a backfill step"
    python3 seal.py --plan add-auth.md --reason "reviewer notes: drop the cache layer"

Snapshots `.waypoint/plans/<slug>.md` into `.waypoint/versions/<slug>/v<N>.md`
exactly as the viewer's Send back and Reflect actions do (the plan text, its
active comments as `v<N>.comments.md`, and the inline-edit baseline cleared),
then records the one-line reason as `v<N>.note.md`. The old version stays
byte-for-byte as it was; the plan you write next is v<N+1>. Prints that number,
which is the `n` for the `revised(v<n>)` stamps.

Idempotent against the viewer: when Reflect already sealed this exact text,
nothing is re-sealed — only the reason is recorded on that version. Sealing an
unchanged plan twice would leave an empty version in the history.

This is a bookkeeping script, not a judgement: run it when you have decided the
plan needs an edit and before the first write. A run that changes nothing
should not call it.
"""

import argparse
import os
import re
import shutil
import sys


def fail(msg):
    print("seal: " + msg, file=sys.stderr)
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
    """Mirrors tick.py / signal.py, so the three never disagree about which
    plan "the current plan" is."""
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
    return os.path.dirname(os.path.dirname(os.path.abspath(plan_path)))


def max_sealed(versions_dir):
    """Same rule as PlanStore.maxSealed: only `v<N>.md` counts."""
    try:
        names = os.listdir(versions_dir)
    except OSError:
        return 0
    ns = [int(m.group(1)) for m in (re.match(r"^v(\d+)\.md$", n) for n in names) if m]
    return max(ns) if ns else 0


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def write_atomic(path, data):
    """Write whole then rename, so a reader never sees a half-written snapshot."""
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(
        description="Seal the current Waypoint plan as a version before rewriting it."
    )
    ap.add_argument("--plan", help="plan slug or path (default: newest non-review plan)")
    ap.add_argument(
        "--reason", required=True,
        help="one line on why the plan is being revised (shown in the viewer's version history)",
    )
    args = ap.parse_args()

    reason = args.reason.strip()
    if not reason:
        fail("--reason must not be empty")
    if "\n" in reason or "\r" in reason:
        fail("--reason must be a single line")

    plan_path = resolve_plan(args.plan)
    plan = os.path.basename(plan_path)
    slug = plan[:-3] if plan.endswith(".md") else plan
    wp = waypoint_dir(plan_path)
    plans_dir = os.path.dirname(os.path.abspath(plan_path))
    versions_dir = os.path.join(wp, "versions", slug)
    comments_path = os.path.join(plans_dir, ".comments", slug + ".md")
    baseline_path = os.path.join(plans_dir, ".edits", slug + ".base.md")

    text = read_bytes(plan_path)
    last = max_sealed(versions_dir)

    # Reflect (or a previous run) already sealed this exact text: record the
    # reason on that version rather than snapshotting it a second time.
    if last and read_bytes(os.path.join(versions_dir, "v%d.md" % last)) == text:
        write_atomic(os.path.join(versions_dir, "v%d.note.md" % last), (reason + "\n").encode("utf-8"))
        print("seal: v%d already holds this text; reason recorded on it" % last)
        print("seal: the plan you write next is v%d" % (last + 1))
        return

    n = last + 1
    os.makedirs(versions_dir, exist_ok=True)
    write_atomic(os.path.join(versions_dir, "v%d.md" % n), text)

    # Active comments belong to the version they were written on. Move the
    # file verbatim (its header already names this version); with none, write
    # the header-only file the extension writes for an empty round.
    sealed_comments = os.path.join(versions_dir, "v%d.comments.md" % n)
    if os.path.isfile(comments_path):
        shutil.move(comments_path, sealed_comments)
    else:
        header = "<!-- waypoint:comments slug=%s version=%d -->\n" % (slug, n)
        write_atomic(sealed_comments, header.encode("utf-8"))

    # Sealing closes the reviewer's edit round: the next version starts with a
    # clean redline, as after a Send back.
    try:
        os.remove(baseline_path)
    except OSError:
        pass

    write_atomic(os.path.join(versions_dir, "v%d.note.md" % n), (reason + "\n").encode("utf-8"))
    print("seal: sealed %s as v%d — %s" % (plan, n, reason))
    print("seal: the plan you write next is v%d" % (n + 1))


if __name__ == "__main__":
    main()
