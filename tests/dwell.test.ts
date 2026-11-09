import { describe, expect, test } from "bun:test";
import { createDwellTracker, type DwellEntry } from "../src/webview/lib/dwell";

function harness(opts: { minMs?: number } = {}) {
  let now = 10_000;
  const flushes: Array<{ dwells: DwellEntry[]; sectionCount: number }> = [];
  const tracker = createDwellTracker({
    ...opts,
    now: () => now,
    onFlush: (dwells, sectionCount) => flushes.push({ dwells, sectionCount }),
  });
  return { tracker, flushes, tick: (ms: number) => (now += ms) };
}

describe("createDwellTracker", () => {
  test("accumulates per section and flushes one batched event", () => {
    const { tracker, flushes, tick } = harness();
    tracker.setSection(0, 5, "Overview");
    tick(3000);
    tracker.setSection(1, 5, "Context");
    tick(2000);
    tracker.flush();
    expect(flushes).toEqual([
      {
        dwells: [
          { s: 0, label: "Overview", ms: 3000 },
          { s: 1, label: "Context", ms: 2000 },
        ],
        sectionCount: 5,
      },
    ]);
  });

  test("drops sub-500ms pass-throughs", () => {
    const { tracker, flushes, tick } = harness();
    tracker.setSection(0, 5, "Overview");
    tick(300);
    tracker.setSection(1, 5, "Context");
    tick(3000);
    tracker.flush();
    expect(flushes).toEqual([
      { dwells: [{ s: 1, label: "Context", ms: 3000 }], sectionCount: 5 },
    ]);
  });

  test("disengage emits the accrued time immediately and freezes accrual", () => {
    const { tracker, flushes, tick } = harness();
    tracker.setSection(0, 3, "Overview");
    tick(1000);
    tracker.setEngaged(false);
    expect(flushes).toEqual([
      { dwells: [{ s: 0, label: "Overview", ms: 1000 }], sectionCount: 3 },
    ]);
    tick(5000);
    tracker.flush();
    expect(flushes).toHaveLength(1); // nothing accrued while disengaged
    tracker.setEngaged(true);
    tick(700);
    tracker.flush();
    expect(flushes[1]).toEqual({
      dwells: [{ s: 0, label: "Overview", ms: 700 }],
      sectionCount: 3,
    });
  });

  test("flush with nothing accrued emits nothing", () => {
    const { tracker, flushes, tick } = harness();
    tracker.flush();
    tracker.setSection(0, 2, "Overview");
    tracker.flush(); // zero elapsed
    tick(200);
    void tick;
    expect(flushes).toHaveLength(0);
  });

  test("a section spanning a flush boundary splits across events without loss", () => {
    const { tracker, flushes, tick } = harness();
    tracker.setSection(0, 3, "Overview");
    tick(1000);
    tracker.flush();
    tick(2000);
    tracker.flush();
    expect(flushes).toEqual([
      { dwells: [{ s: 0, label: "Overview", ms: 1000 }], sectionCount: 3 },
      { dwells: [{ s: 0, label: "Overview", ms: 2000 }], sectionCount: 3 },
    ]);
    const total = flushes.flatMap((f) => f.dwells).reduce((t, d) => t + d.ms, 0);
    expect(total).toBe(3000);
  });

  test("setSection(-1) pauses accrual until a real section returns", () => {
    const { tracker, flushes, tick } = harness();
    tracker.setSection(0, 3, "Phase 1");
    tick(1000);
    tracker.setSection(-1, 3, "");
    tick(5000);
    tracker.setSection(1, 3, "Phase 2");
    tick(700);
    tracker.flush();
    expect(flushes).toEqual([
      {
        dwells: [
          { s: 0, label: "Phase 1", ms: 1000 },
          { s: 1, label: "Phase 2", ms: 700 },
        ],
        sectionCount: 3,
      },
    ]);
  });

  test("destroy flushes the remainder once", () => {
    const { tracker, flushes, tick } = harness();
    tracker.setSection(1, 4, "Phase 1");
    tick(900);
    tracker.destroy();
    expect(flushes).toEqual([
      { dwells: [{ s: 1, label: "Phase 1", ms: 900 }], sectionCount: 4 },
    ]);
  });
});
