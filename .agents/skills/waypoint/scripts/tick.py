#!/usr/bin/env python3
"""Tick a Waypoint acceptance-gate criterion by ID.

    python3 tick.py C4 --evidence "bun test exited 0"
    python3 tick.py C4 --override "flaky upstream; accepted by user"

Flips the criterion's `- [ ]` to `- [x]` in the plan file and records the
proof (or override reason) as the indented continuation line the Waypoint
viewer expects, changing nothing else. Refuses `@human` criteria (those are
ticked by the reviewer in the viewer) and duplicate IDs. The scan mirrors the
viewer's parsers: fenced code blocks are inert, `:::checklist` blocks scope
criteria, `## Phase N` headings assign phases.
"""

import argparse
import os
import re
import sys

ID_PATTERN = r"[A-Za-z][A-Za-z0-9._-]*"
CRITERION = re.compile(r"^(\s*-\s*\[)([ xX])(\]\s+)(.*\S)\s*$")
NOTE = re.compile(r"^\s{2,}(override|evidence):\s*\S", re.IGNORECASE)


def fail(msg):
    print("tick: " + msg, file=sys.stderr)
    sys.exit(1)


def make_fence_tracker():
    """Port of src/webview/lib/fences.ts — True for delimiter/fenced lines."""
    state = {"ch": None, "len": 0}

    def track(line):
        m = re.match(r"^\s*(`{3,}|~{3,})", line)
        if m:
            ch, ln = m.group(1)[0], len(m.group(1))
            if state["ch"] is None:
                state["ch"], state["len"] = ch, ln
            elif (
                ch == state["ch"]
                and ln >= state["len"]
                and re.match(r"^\s*(?:`{3,}|~{3,})\s*$", line)
            ):
                state["ch"] = None
            return True
        return state["ch"] is not None

    return track


def scan(lines):
    """One pass over the plan, mirroring computeDrift in src/webview/lib/drift.ts."""
    fenced = make_fence_tracker()
    criteria = []
    phase = 0
    in_checklist = False
    last = None
    for i, line in enumerate(lines):
        if fenced(line):
            continue
        if re.match(r"^##\s+", line) and not line.startswith("###"):
            m = re.match(r"^##\s+phase\s+(\d+)", line, re.IGNORECASE)
            phase = int(m.group(1)) if m else 0
            in_checklist = False
            continue
        if re.match(r"^:::checklist\b", line):
            in_checklist = True
            last = None
            continue
        if line.startswith(":::"):
            in_checklist = False
            continue
        if not in_checklist:
            continue
        m = CRITERION.match(line)
        if m:
            # Leading `#<id>` / `@human` tokens, each at most once, either order.
            rest = m.group(4)
            human = False
            cid = None
            while True:
                t = None
                if not human:
                    t = re.match(r"^@human\s+", rest)
                    if t:
                        human = True
                if t is None and cid is None:
                    t = re.match("^#(" + ID_PATTERN + r")\s+", rest)
                    if t:
                        cid = t.group(1)
                if t is None:
                    break
                rest = rest[t.end():]
            last = {
                "line_no": i,
                "marker_pos": m.end(1),
                "checked": m.group(2).lower() == "x",
                "id": cid,
                "human": human,
                "phase": phase,
                "has_note": False,
                "text": rest,
            }
            criteria.append(last)
        elif last is not None and NOTE.match(line):
            last["has_note"] = True
    return criteria


def default_plans_dir():
    """`.waypoint/plans`, or the pre-rename `.galley/plans` when only that
    exists, so workspaces initialized before the rename keep working."""
    for root in (".waypoint", ".galley"):
        d = os.path.join(root, "plans")
        if os.path.isdir(d):
            return d
    return os.path.join(".waypoint", "plans")


def resolve_plan(arg):
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


def describe(c):
    return "#%s%s" % (c["id"], "(@human)" if c["human"] else "")


def unticked_summary(criteria):
    by_phase = {}
    for c in criteria:
        if c["id"] and not c["checked"]:
            by_phase.setdefault(c["phase"], []).append(describe(c))
    if not by_phase:
        return "no unticked criteria with IDs"
    return "; ".join(
        "phase %d: %s" % (p, ", ".join(ids)) for p, ids in sorted(by_phase.items())
    )


def print_remaining(criteria, c):
    rest = [o for o in criteria if o["phase"] == c["phase"] and o is not c and not o["checked"]]
    if rest:
        print("phase %d remaining: %s" % (c["phase"], ", ".join(describe(o) if o["id"] else "(no id)" for o in rest)))
    else:
        print("phase %d gate: all criteria ticked" % c["phase"])


def main():
    ap = argparse.ArgumentParser(description="Tick a Waypoint gate criterion by ID.")
    ap.add_argument("id", help="criterion ID, e.g. C4 or #C4")
    ap.add_argument("--plan", help="plan slug or path (default: newest non-review plan in .waypoint/plans/, or .galley/plans/)")
    proof = ap.add_mutually_exclusive_group(required=True)
    proof.add_argument("--evidence", help="proof the criterion named (command + exit code, or output/log path)")
    proof.add_argument("--override", help="user-sanctioned reason for ticking a failed criterion")
    args = ap.parse_args()

    cid = args.id.lstrip("#")
    if not re.match("^(%s)$" % ID_PATTERN, cid):
        fail("invalid criterion ID %r" % args.id)
    kind = "evidence" if args.override is None else "override"
    value = (args.evidence or args.override).strip()
    if not value:
        fail("--%s must not be empty" % kind)
    if "\n" in value or "\r" in value:
        fail("--%s must be a single line" % kind)

    path = resolve_plan(args.plan)
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    criteria = scan(lines)

    matches = [c for c in criteria if c["id"] == cid]
    if not matches:
        fail("no criterion #%s in %s\nunticked: %s" % (cid, path, unticked_summary(criteria)))
    if len(matches) > 1:
        fail(
            "#%s appears on %d criteria (lines %s) — fix the duplicate IDs in the plan before ticking"
            % (cid, len(matches), ", ".join(str(c["line_no"] + 1) for c in matches))
        )
    c = matches[0]
    if c["human"]:
        fail("refused — #%s is @human; only the reviewer ticks it in the Waypoint viewer" % cid)

    if c["checked"] and c["has_note"]:
        print("already ticked: #%s (no change)" % cid)
        print_remaining(criteria, c)
        return

    note = "  %s: %s" % (kind, value)
    if not c["checked"]:
        line = lines[c["line_no"]]
        pos = c["marker_pos"]
        lines[c["line_no"]] = line[:pos] + "x" + line[pos + 1:]
    lines.insert(c["line_no"] + 1, note)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    verb = "ticked" if not c["checked"] else "recorded %s for already-ticked" % kind
    print("%s: #%s %s" % (verb, cid, c["text"]))
    print_remaining(criteria, c)


if __name__ == "__main__":
    main()
