#!/usr/bin/env python3
"""PreToolUse hook (Edit|Write|MultiEdit|NotebookEdit): the Waypoint plan gate.

While the .waypoint/gate sentinel exists (armed by waypoint_gate_prompt.py
during plan review), deny any edit whose target is outside .waypoint/plans/
or ~/.claude/plans/ (the harness's own plan file). Fails open on missing or
garbled input — the gate is a backstop against drifting into implementation,
and a hook bug must never brick editing.
"""

import json
import os
import sys


def main() -> None:
    try:
        data = json.load(sys.stdin)
        cwd = data.get("cwd") or os.getcwd()
        tool_input = data.get("tool_input") or {}
        path = tool_input.get("file_path") or tool_input.get("notebook_path")
    except Exception:
        return
    if not path:
        return
    roots = (".waypoint", ".galley")  # current name, then the pre-rename one
    if not any(os.path.exists(os.path.join(cwd, r, "gate")) for r in roots):
        return
    target = os.path.realpath(os.path.join(cwd, path))
    allowed = tuple(os.path.realpath(os.path.join(cwd, r, "plans")) for r in roots) + (
        os.path.realpath(os.path.expanduser(os.path.join("~", ".claude", "plans"))),
    )
    for prefix in allowed:
        if target == prefix or target.startswith(prefix + os.sep):
            return
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        "The Waypoint plan is in review (.waypoint/gate is armed); "
                        "only files under .waypoint/plans/ may be edited. To start "
                        "implementing, accept the plan in the Waypoint viewer "
                        "(/waypoint-implement) — or any plain prompt from the user "
                        "unlocks editing."
                    ),
                }
            }
        )
    )


if __name__ == "__main__":
    main()
