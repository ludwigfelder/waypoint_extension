import { join } from "node:path";

/**
 * Where a workspace keeps its plans. Prefer `.waypoint`; fall back to the
 * pre-rename `.galley` and the older `.claude/waypoint`; default to
 * `.waypoint`. Workspaces initialized before the rename keep working without
 * any on-disk migration.
 */
export function waypointDirCandidates(wsPath: string): string[] {
  return [
    join(wsPath, ".waypoint"),
    join(wsPath, ".galley"),
    join(wsPath, ".claude", "waypoint"),
  ];
}

export function pickWaypointDir(wsPath: string, exists: (p: string) => boolean): string {
  const candidates = waypointDirCandidates(wsPath);
  return candidates.find(exists) ?? candidates[0];
}
