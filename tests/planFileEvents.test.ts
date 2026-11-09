import { describe, expect, test } from "bun:test";
import { reconcilePlanFile } from "../src/extension/planFileEvents";

describe("reconcilePlanFile", () => {
  test("a plan with no plan_created in the log is a creation", () => {
    expect(reconcilePlanFile(false, undefined, 1000)).toBe("created");
    // Whatever its mtime, and whatever we happen to have cached.
    expect(reconcilePlanFile(false, 5000, 1000)).toBe("created");
  });

  test("a known plan whose mtime advanced is an update", () => {
    expect(reconcilePlanFile(true, 1000, 1001)).toBe("updated");
    // First write this session against a plan created in an earlier one.
    expect(reconcilePlanFile(true, undefined, 1000)).toBe("updated");
  });

  test("a repeat event at the same or an older mtime is silent", () => {
    expect(reconcilePlanFile(true, 1000, 1000)).toBe("none");
    expect(reconcilePlanFile(true, 1000, 999)).toBe("none");
  });

  // The defect this exists to fix: an agent rewriting a plan atomically makes
  // VS Code report create, not change. Routing on the event kind sent that to
  // `planCreated`, whose once-per-plan guard swallowed it, so a send-back
  // regeneration logged nothing at all.
  test("a create event on an already-created plan reads as an update", () => {
    expect(reconcilePlanFile(true, 1000, 2000)).toBe("updated");
  });

  test("mtime equal to zero is not mistaken for absent", () => {
    expect(reconcilePlanFile(true, 0, 0)).toBe("none");
    expect(reconcilePlanFile(true, 0, 1)).toBe("updated");
  });
});
