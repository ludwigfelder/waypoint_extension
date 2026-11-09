# Changelog

## 0.3.0 — 2026-11-09

Published as a new Marketplace extension,
`LudwigFelder.waypoint-plan-reviewer` (display name *Waypoint Plan
Reviewer*), under the name used in the paper; the bare name `waypoint` is
taken on the Marketplace. It replaces
`LudwigFelder.galley`; Marketplace ids cannot be renamed.

- **Renamed from Galley back to Waypoint.** Commands are `waypoint.open` and
  `waypoint.installSkills`, settings are `waypoint.terminalName` and
  `waypoint.agent`, the workspace data dir is `.waypoint/`, and the agent
  skills are `/waypoint`, `/waypoint-apply`, `/waypoint-implement` and
  `/waypoint-update` (Codex: `$waypoint-…`).
- **Galley workspaces keep working.** The extension, the kit helpers and the
  review-gate hooks read a `.galley/` dir when no `.waypoint/` exists.
  *Install Agent Skills* and *Reinstall Waypoint* remove leftover `galley*`
  skill dirs.
- **Settings do not carry over.** Set `waypoint.terminalName` or
  `waypoint.agent` instead of the `galley.*` ones.
- Uninstall Galley after installing Waypoint, so the two don't both open a
  viewer.

## 0.2.0 — 2026-09-11

First public release on the VS Code Marketplace, as `LudwigFelder.galley`.

- **Renamed from Waypoint to Galley.** Commands are now `galley.open` and
  `galley.installSkills` (shown as *Galley: Open Plan Viewer* and *Galley:
  Install Agent Skills into This Repo*), settings are `galley.terminalName`
  and `galley.agent`, the workspace data dir is `.galley/`, and the agent
  skills are `/galley`, `/galley-apply`, `/galley-implement` and
  `/galley-update` (Codex: `$galley-…`).
- **Workspaces initialized before the rename keep working.** The extension,
  the kit's `tick.py`, `signal.py` and `seal.py` helpers and the review-gate
  hooks all read a `.waypoint/` dir (or the older `.claude/waypoint/`) when
  no `.galley/` exists. Nothing is moved on disk.
- **Old skill dirs are cleaned up on request.** *Install Agent Skills* and
  *Reinstall Galley* remove pre-rename `waypoint*` skill dirs from
  `.agents/skills/` and `.claude/skills/` (never on activation, and never
  through a symlink). Stale `.claude/commands/waypoint*.md` wrappers are
  removed as before.
- **Settings do not carry over.** If you had set `waypoint.terminalName` or
  `waypoint.agent`, set `galley.terminalName` or `galley.agent` instead.
- New icon.
