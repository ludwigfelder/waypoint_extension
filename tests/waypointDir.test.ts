import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pickWaypointDir } from "../src/extension/waypointDir";

const ws = "/ws";
const has = (...present: string[]) => (p: string) => present.includes(p);

describe("pickWaypointDir", () => {
  test("prefers .waypoint when present", () => {
    expect(
      pickWaypointDir(ws, has(join(ws, ".waypoint"), join(ws, ".galley"))),
    ).toBe(join(ws, ".waypoint"));
  });

  test("falls back to the pre-rename .galley", () => {
    expect(pickWaypointDir(ws, has(join(ws, ".galley")))).toBe(join(ws, ".galley"));
  });

  test("then to the older .claude/waypoint", () => {
    expect(pickWaypointDir(ws, has(join(ws, ".claude", "waypoint")))).toBe(
      join(ws, ".claude", "waypoint"),
    );
  });

  test("defaults to .waypoint for a fresh workspace", () => {
    expect(pickWaypointDir(ws, () => false)).toBe(join(ws, ".waypoint"));
  });
});
