#!/usr/bin/env python3
"""UserPromptSubmit hook: arm/disarm the Waypoint plan-review gate.

A prompt that enters or continues plan review (/waypoint, /waypoint-apply,
/waypoint-update) creates the .waypoint/gate sentinel; any other prompt —
including /waypoint-implement, whether typed by the viewer's Accept or by
hand — removes it. Always exits 0: this hook never blocks a prompt, and a
garbled payload leaves the gate untouched.
"""

import json
import os
import re
import sys

ARMING = re.compile(r"^/waypoint(-apply|-update)?(\s|$)")


def gate_root(cwd: str) -> str:
    """`.waypoint/`, or the pre-rename `.galley/` when only that exists."""
    for root in (".waypoint", ".galley"):
        if os.path.isdir(os.path.join(cwd, root)):
            return os.path.join(cwd, root)
    return os.path.join(cwd, ".waypoint")


def main() -> None:
    try:
        data = json.load(sys.stdin)
        prompt = (data.get("prompt") or "").strip()
        cwd = data.get("cwd") or os.getcwd()
    except Exception:
        return
    gate = os.path.join(gate_root(cwd), "gate")
    if ARMING.match(prompt):
        try:
            os.makedirs(os.path.dirname(gate), exist_ok=True)
            open(gate, "w").close()
        except OSError:
            pass
    else:
        try:
            os.remove(gate)
        except OSError:
            pass


if __name__ == "__main__":
    main()
