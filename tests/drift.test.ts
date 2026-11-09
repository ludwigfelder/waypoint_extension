import { describe, expect, test } from "bun:test";
import "./setup-dom";
import {
  assertInteractionEvent,
  INTERACTION_LOG_SCHEMA_VERSION,
} from "../src/shared/interactionLog";

// drift.ts imports markdown.ts (for the shared token grammar), which needs the
// DOM globals at import time — same dance as markdown.test.ts.
const { computeDrift } = await import("../src/webview/lib/drift");

const gate = (checks: string, n = 1) =>
  `## Phase ${n}: P${n}\n\n### Phase ${n} acceptance gate\n\n:::checklist\n${checks}\n:::\n`;

describe("deviations", () => {
  test("deviation bullets are extracted with IDs and phase attribution; prose bullets ignored", () => {
    const md =
      gate("- [x] #C1 done.\n  evidence: ok.") +
      ":::runrecord\n- deviation(D3): used X instead of Y.\n- decided: split the phase.\n:::\n" +
      gate("- [x] #C2 done.\n  evidence: ok.", 2) +
      ":::runrecord\n- deviation(D7): skipped the cache.\n:::\n";
    const d = computeDrift(md);
    expect(d.deviations).toEqual([
      { id: "D3", text: "used X instead of Y.", phase: 1 },
      { id: "D7", text: "skipped the cache.", phase: 2 },
    ]);
    expect(d.postRun).toBe(true);
  });
});

describe("tick classification", () => {
  test("evidence → derived, bare non-human → asserted, @human → human", () => {
    const md = gate(
      [
        "- [x] #C1 tests pass.",
        "  evidence: bun test exited 0.",
        "- [x] #C2 bare tick.",
        "- [x] #C3 @human looks right.",
        "- [ ] #C4 unticked.",
      ].join("\n"),
    );
    const d = computeDrift(md);
    expect(d.ticks).toEqual({ derived: 1, asserted: 1, human: 1 });
  });
});

describe("postRun", () => {
  test("false for legacy plans (green gates, no evidence or runrecord)", () => {
    const d = computeDrift(gate("- [x] legacy done.\n- [x] also done."));
    expect(d.postRun).toBe(false);
  });

  test("true only when gates are green AND evidence or runrecord present", () => {
    const green = gate("- [x] #C1 done.\n  evidence: ok.");
    expect(computeDrift(green).postRun).toBe(true);
    const notGreen = gate("- [x] #C1 done.\n  evidence: ok.\n- [ ] #C2 open.");
    expect(computeDrift(notGreen).postRun).toBe(false);
    const recordOnly = gate("- [x] #C1 done.") + ":::runrecord\n- decided: n/a.\n:::\n";
    expect(computeDrift(recordOnly).postRun).toBe(true);
  });
});

describe("dangling probes", () => {
  const probe = (ref: string) =>
    `:::assumption #A1 verified:probe(${ref})\nPremise.\n:::\n\n`;

  test("missing criterion → dangling", () => {
    const d = computeDrift(probe("C9") + gate("- [x] #C1 done.\n  evidence: ok."));
    expect(d.danglingProbes).toEqual(["C9"]);
  });

  test("unticked criterion → dangling; ticked → resolved", () => {
    const unticked = computeDrift(
      probe("C2") + gate("- [x] #C1 done.\n  evidence: ok.\n- [ ] #C2 probe target."),
    );
    expect(unticked.danglingProbes).toEqual(["C2"]);
    const ticked = computeDrift(
      probe("C2") + gate("- [x] #C1 done.\n  evidence: ok.\n- [x] #C2 probe target.\n  evidence: ok."),
    );
    expect(ticked.danglingProbes).toEqual([]);
  });
});

describe("duplicate IDs", () => {
  test("repeated IDs across callouts and criteria are detected", () => {
    const md =
      ":::assumption #A1 asserted\nOne.\n:::\n\n:::decision #A1\nTwo.\n:::\n\n" +
      gate("- [x] #C1 done.\n  evidence: ok.");
    const d = computeDrift(md);
    expect(d.duplicateIds).toEqual(["A1"]);
  });

  test("unique IDs report nothing", () => {
    const md =
      ":::assumption #A1 asserted\nOne.\n:::\n\n" + gate("- [x] #C1 done.\n  evidence: ok.");
    expect(computeDrift(md).duplicateIds).toEqual([]);
  });
});

describe("fence blindness is gone", () => {
  test("a fenced runrecord example is inert", () => {
    const md =
      gate("- [x] #C1 done.\n  evidence: ok.") +
      "```\n:::runrecord\n- deviation(D9): fenced decoy.\n:::\n```\n";
    const d = computeDrift(md);
    expect(d.deviations).toEqual([]);
    // postRun still true: the real evidence line counts, the decoy doesn't.
    expect(d.postRun).toBe(true);
  });
});

describe("drift_view_shown event", () => {
  test("assertInteractionEvent accepts it", () => {
    assertInteractionEvent({
      schemaVersion: INTERACTION_LOG_SCHEMA_VERSION,
      eventId: "e1",
      timestamp: new Date(0).toISOString(),
      plan: "plan.md",
      version: 1,
      type: "drift_view_shown",
      deviationCount: 2,
      assertedCount: 1,
      danglingProbeCount: 0,
      duplicateIdCount: 0,
    });
  });
});
