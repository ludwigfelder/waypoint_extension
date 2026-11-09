import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCommand } from "../src/extension/agentCommand";
import { parsePhases, prefixDone } from "../src/webview/lib/phases";
import { InteractionLogger } from "../src/extension/interactionLogger";
import { InteractionTracker } from "../src/extension/interactionTracker";
import {
  assertInteractionEvent,
  INTERACTION_LOG_SCHEMA_VERSION,
} from "../src/shared/interactionLog";

describe("formatCommand", () => {
  test("claude gets the slash command with an explicit --up-to-phase flag", () => {
    expect(formatCommand("claude", "waypoint-implement", "my plan.md", 2)).toBe(
      "/waypoint-implement my plan.md --up-to-phase 2",
    );
    expect(formatCommand("claude", "waypoint-implement", "plan.md")).toBe(
      "/waypoint-implement plan.md",
    );
    expect(formatCommand("claude", "waypoint-apply")).toBe("/waypoint-apply");
  });

  test("waypoint-update maps to the slash command / a reconcile phrase", () => {
    expect(formatCommand("claude", "waypoint-update", "plan.md")).toBe(
      "/waypoint-update plan.md",
    );
    const phrase = formatCommand("unknown", "waypoint-update", "plan.md");
    expect(phrase).toContain("waypoint-update skill");
    expect(phrase).toContain("plan.md");
    expect(phrase).toContain("remaining phases");
  });

  test("an undetermined agent gets a phase-capped instruction phrase", () => {
    const capped = formatCommand("unknown", "waypoint-implement", "plan.md", 2);
    expect(capped).toContain("only phases 1 through 2");
    expect(capped).toContain("stop after phase 2");
    expect(capped).toContain("plan.md");
    const full = formatCommand("unknown", "waypoint-implement", "plan.md");
    expect(full).not.toContain("only phases");
    expect(full).toContain("waypoint-implement skill");
  });

  // The fallback must be typeable into either CLI: a `/` would hard-fail in
  // Codex, and a `$` names a skill Claude does not resolve that way (#D1).
  test("the fallback phrase carries no command prefix", () => {
    const phrase = formatCommand("unknown", "waypoint-apply");
    expect(phrase).toContain("waypoint-apply skill");
    expect(phrase).not.toContain("/");
    expect(phrase).not.toContain("$");
  });

  test("codex invokes the skill explicitly with $", () => {
    expect(formatCommand("codex", "waypoint-apply")).toBe("$waypoint-apply");
    const capped = formatCommand("codex", "waypoint-implement", "my plan.md", 2);
    expect(capped.startsWith("$waypoint-implement")).toBe(true);
    expect(capped).toContain("my plan.md");
    expect(capped).toContain("stop after phase 2");
    const full = formatCommand("codex", "waypoint-implement", "my plan.md");
    expect(full.startsWith("$waypoint-implement")).toBe(true);
    expect(full).not.toContain("only phases");
    const update = formatCommand("codex", "waypoint-update", "plan.md");
    expect(update.startsWith("$waypoint-update")).toBe(true);
    expect(update).toContain("plan.md");
  });
});

describe("prefixDone", () => {
  const plan = (checks: string[]) =>
    checks
      .map(
        (c, i) =>
          `## Phase ${i + 1}: P${i + 1}\n\n### Phase ${i + 1} acceptance gate\n\n:::checklist\n${c}\n:::\n`,
      )
      .join("\n");

  test("true only when every phase in the prefix is fully ticked", () => {
    const phases = parsePhases(
      plan(["- [x] a\n- [x] b", "- [x] c", "- [ ] d"]),
    );
    expect(prefixDone(phases, 2)).toBe(true);
    expect(prefixDone(phases, 3)).toBe(false);
    const partial = parsePhases(plan(["- [x] a\n- [ ] b", "- [x] c", "- [ ] d"]));
    expect(prefixDone(partial, 2)).toBe(false);
  });

  test("a zero-criteria phase in the prefix does not block it", () => {
    const md =
      `## Phase 1: No gate\n\nProse only.\n\n` +
      plan(["- [x] a"]).replace(/Phase 1/g, "Phase 2");
    const phases = parsePhases(md);
    expect(phases[0].total).toBe(0);
    expect(prefixDone(phases, 2)).toBe(true);
  });

  test("guards empty and out-of-range inputs", () => {
    expect(prefixDone([], 1)).toBe(false);
    const phases = parsePhases(plan(["- [x] a"]));
    expect(prefixDone(phases, 0)).toBe(false);
    expect(prefixDone(phases, 5)).toBe(true); // clamped to existing phases
  });

  test("#IDs and override: lines do not change parsePhases totals", () => {
    const phases = parsePhases(
      plan([
        "- [x] #C1 `bun test` exits 0.\n  override: flaky upstream fixture.\n- [ ] #C2 @human Chips legible.",
      ]),
    );
    expect(phases[0].total).toBe(2);
    expect(phases[0].checked).toBe(1);
  });

  test("evidence: lines and runrecord blocks do not change totals", () => {
    const md =
      plan(["- [x] #C1 tests pass.\n  evidence: bun test exited 0.\n- [x] #C2 build ok.\n  evidence: bun run build exited 0."]) +
      "\n:::runrecord\n- deviation(D1): used X instead of Y.\n:::\n";
    const phases = parsePhases(md);
    expect(phases.length).toBe(1);
    expect(phases[0].total).toBe(2);
    expect(phases[0].checked).toBe(2);
  });

  test("fenced phase headings, checklists, and checkboxes are inert", () => {
    const md =
      plan(["- [x] real criterion"]) +
      "\n```\n## Phase 9: Fake\n:::checklist\n- [ ] fenced checkbox\n:::\n```\n";
    const phases = parsePhases(md);
    expect(phases.length).toBe(1);
    expect(phases[0].total).toBe(1);
    expect(phases[0].checked).toBe(1);
  });
});

describe("cross_cutting_comment event", () => {
  const base = {
    schemaVersion: INTERACTION_LOG_SCHEMA_VERSION,
    eventId: "e1",
    timestamp: new Date(0).toISOString(),
    plan: "plan.md",
    version: 1,
  };

  test("assertInteractionEvent accepts the new event type", () => {
    assertInteractionEvent({
      ...base,
      type: "cross_cutting_comment",
      commentId: "c1",
      commentCount: 3,
    });
  });

  test("unknown fields on it are rejected", () => {
    expect(() =>
      assertInteractionEvent({
        ...base,
        type: "cross_cutting_comment",
        commentId: "c1",
        commentCount: 3,
        stray: true,
      }),
    ).toThrow(/unexpected interaction fields/);
  });
});

describe("plan_accepted with upToPhase", () => {
  test("assertInteractionEvent accepts the new optional field", () => {
    assertInteractionEvent({
      schemaVersion: INTERACTION_LOG_SCHEMA_VERSION,
      eventId: "e1",
      timestamp: new Date(0).toISOString(),
      plan: "plan.md",
      version: 1,
      type: "plan_accepted",
      iterationCount: 0,
      creationToActionMs: 10,
      activeReadingMs: 5,
      terminalInjected: true,
      upToPhase: 2,
    });
  });

  const dirs: string[] = [];
  afterEach(async () =>
    Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))),
  );

  test("round-trips through tracker + logger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-accept-"));
    dirs.push(dir);
    let now = 1_000;
    let id = 0;
    const logger = new InteractionLogger(dir, () => now, undefined, () => `e${++id}`);
    const tracker = new InteractionTracker(logger, () => now, () => `s${++id}`);
    await tracker.init();
    await tracker.planCreated("plan.md", 1, 900);
    await tracker.planAccepted("plan.md", 1, 0, true, 2);
    await tracker.planAccepted("plan.md", 1, 0, true); // full accept: no field
    const accepted = tracker
      .snapshot()
      .filter((e) => e.type === "plan_accepted") as any[];
    expect(accepted).toHaveLength(2);
    expect(accepted[0].upToPhase).toBe(2);
    expect("upToPhase" in accepted[1]).toBe(false);
  });
});
