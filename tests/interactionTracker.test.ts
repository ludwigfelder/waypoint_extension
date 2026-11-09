import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InteractionLogger } from "../src/extension/interactionLogger";
import { InteractionTracker } from "../src/extension/interactionTracker";
import { recordPlanFileEvent } from "../src/extension/planFileEvents";
import { PlanStore } from "../src/extension/planStore";
import { assertInteractionEvent } from "../src/shared/interactionLog";
import { criterionKey, isHumanCriterion } from "../src/extension/criterion";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-track-"));
  dirs.push(dir);
  let now = 1_000;
  let id = 0;
  const logger = new InteractionLogger(dir, () => now, undefined, () => `event-${++id}`);
  const tracker = new InteractionTracker(logger, () => now, () => `session-${++id}`);
  await tracker.init();
  return { tracker, tick: (ms: number) => (now += ms) };
}

describe("InteractionTracker", () => {
  test("tracks only visible time across selection and visibility changes", async () => {
    const { tracker, tick } = await harness();
    await tracker.setVisible(true);
    await tracker.selectPlan("a.md", 1, "selection", 900);
    tick(100);
    await tracker.selectPlan("b.md", 1, "selection", 950);
    tick(50);
    await tracker.setVisible(false);
    tick(500);
    await tracker.setVisible(true);
    tick(25);
    await tracker.dispose();
    const ended = tracker.snapshot().filter((event) => event.type === "plan_view_ended");
    expect(ended.map((event: any) => [event.plan, event.durationMs, event.reason])).toEqual([
      ["a.md", 100, "selection_changed"],
      ["b.md", 50, "panel_hidden"],
      ["b.md", 25, "panel_disposed"],
    ]);
  });

  test("records create then updates without duplicates", async () => {
    const { tracker } = await harness();
    await tracker.planCreated("a.md", 1, 100);
    await tracker.planCreated("a.md", 1, 100);
    await tracker.planUpdated("a.md", 1, 200);
    expect(tracker.snapshot().map((event) => event.type)).toEqual(["plan_created", "plan_updated"]);
  });

  test("preserves a historical version and infers a baseline", async () => {
    const { tracker } = await harness();
    await tracker.setVisible(true);
    await tracker.selectPlan("old.md", 2, "selection", 100);
    expect(tracker.snapshot().map((event) => [event.type, event.version])).toEqual([
      ["plan_created", 2],
      ["plan_view_started", 2],
    ]);
    expect((tracker.snapshot()[0] as any).inferred).toBe(true);
  });

  test("loads a historical version without mutating plan or comment files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-version-"));
    dirs.push(dir);
    const plans = join(dir, "plans");
    const versions = join(dir, "versions", "a");
    await mkdir(join(plans, ".comments"), { recursive: true });
    await mkdir(versions, { recursive: true });
    await writeFile(join(plans, "a.md"), "# Current\n");
    await writeFile(join(versions, "v1.md"), "# Original\n");
    await writeFile(join(versions, "v1.comments.md"), "<!-- waypoint:comments slug=a version=1 -->\n");
    const store = new PlanStore(dir);
    const before = await Promise.all([
      readFile(join(plans, "a.md"), "utf8"),
      readFile(join(versions, "v1.comments.md"), "utf8"),
    ]);
    const loaded = await store.getVersion("a.md", 1);
    const after = await Promise.all([
      readFile(join(plans, "a.md"), "utf8"),
      readFile(join(versions, "v1.comments.md"), "utf8"),
    ]);
    expect([loaded.version, loaded.current, loaded.markdown]).toEqual([1, false, "# Original\n"]);
    expect(after).toEqual(before);
  });

  test("does not double-close on reload or disposal", async () => {
    const { tracker, tick } = await harness();
    await tracker.setVisible(true);
    await tracker.selectPlan("a.md", 1, "selection", 100);
    await tracker.selectPlan("a.md", 1, "reload", 100);
    tick(10);
    await tracker.dispose();
    await tracker.dispose();
    expect(tracker.snapshot().filter((event) => event.type === "plan_view_ended")).toHaveLength(1);
  });

  test("records comment metadata and aggregates two review iterations", async () => {
    const { tracker, tick } = await harness();
    await tracker.planCreated("a.md", 1, 900);
    await tracker.setVisible(true);
    await tracker.selectPlan("a.md", 1, "selection", 900);
    tick(20);
    await tracker.trackClientInteraction("a.md", 1, {
      type: "comment_created", commentId: "c1", commentCount: 1, commentCreatedAt: 1_015,
    });
    tick(30);
    await tracker.reviewSent("a.md", 1, [{ createdAt: 1_015 }], true);
    await tracker.selectPlan("a.md", 2, "reload", 900);
    tick(10);
    await tracker.trackClientInteraction("a.md", 2, {
      type: "comment_deleted", commentId: "c1", commentCount: 0, commentCreatedAt: 1_015,
    });
    await tracker.reviewSent("a.md", 2, [{ createdAt: 1_060 }, { createdAt: 1_070 }], false);
    const events = tracker.snapshot();
    const comments = events.filter((event) => event.type.startsWith("comment_")) as any[];
    expect(comments.map(({ type, commentId, commentCount }) => [type, commentId, commentCount])).toEqual([
      ["comment_created", "c1", 1], ["comment_deleted", "c1", 0],
    ]);
    const reviews = events.filter((event) => event.type === "review_sent") as any[];
    expect(reviews.map((event) => event.iteration)).toEqual([1, 2]);
    expect(reviews[0]).toMatchObject({
      commentCount: 1, creationToActionMs: 150, latestUpdateToActionMs: 150,
      activeReadingMs: 50, firstViewToFirstCommentMs: 15, commentSpanMs: 0,
      terminalInjected: true,
    });
    expect(reviews[1]).toMatchObject({ commentCount: 2, commentSpanMs: 10 });
  });

  test("acceptance includes iterations, lifecycle time, active reading, and handoff result", async () => {
    const { tracker, tick } = await harness();
    await tracker.planCreated("a.md", 1, 900);
    await tracker.setVisible(true);
    await tracker.selectPlan("a.md", 3, "selection", 900);
    tick(40);
    await tracker.planAccepted("a.md", 3, 2, true);
    const accepted = tracker.snapshot().find((event) => event.type === "plan_accepted");
    expect(accepted).toMatchObject({
      version: 3, iterationCount: 2, creationToActionMs: 140,
      activeReadingMs: 40, terminalInjected: true,
    });
  });

  test("focus flips shrink focusedMs but never durationMs", async () => {
    const { tracker, tick } = await harness();
    await tracker.setVisible(true);
    await tracker.selectPlan("a.md", 1, "selection", 900);
    tick(20);
    await tracker.setFocus(false);
    tick(60);
    await tracker.setFocus(true);
    tick(20);
    await tracker.dispose();
    const ended = tracker.snapshot().find((event) => event.type === "plan_view_ended") as any;
    expect(ended.durationMs).toBe(100);
    expect(ended.focusedMs).toBe(40);
    const flips = tracker.snapshot().filter((event) => event.type === "webview_focus") as any[];
    expect(flips.map((event) => event.focused)).toEqual([false, true]);
  });

  test("activeReadingMs in review_sent counts focused time only", async () => {
    const { tracker, tick } = await harness();
    await tracker.planCreated("a.md", 1, 900);
    await tracker.setVisible(true);
    await tracker.selectPlan("a.md", 1, "selection", 900);
    tick(30);
    await tracker.setFocus(false);
    tick(70);
    await tracker.reviewSent("a.md", 1, [], true);
    const review = tracker.snapshot().find((event) => event.type === "review_sent") as any;
    expect(review.activeReadingMs).toBe(30);
  });

  test("flushSync writes one parseable window_closed interval and is idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-flush-"));
    dirs.push(dir);
    let now = 1_000;
    let id = 0;
    const written: string[] = [];
    const logger = new InteractionLogger(
      dir, () => now, undefined, () => `e${++id}`,
      (_path, data) => written.push(data),
    );
    const tracker = new InteractionTracker(logger, () => now, () => `s${++id}`);
    await tracker.init();
    await tracker.setVisible(true);
    await tracker.selectPlan("a.md", 1, "selection", 900);
    now += 42;
    tracker.flushSync();
    tracker.flushSync();
    expect(written).toHaveLength(1);
    const event = JSON.parse(written[0]);
    expect(() => assertInteractionEvent(event)).not.toThrow();
    expect(event).toMatchObject({
      type: "plan_view_ended", reason: "window_closed", durationMs: 42, focusedMs: 42,
    });
  });

  test("emit appends in memory without re-reading the log file", async () => {
    const { tracker } = await harness();
    (tracker.logger as any).readAll = () => {
      throw new Error("emit must not re-read the log");
    };
    for (let i = 0; i < 25; i++) {
      await tracker.trackClientInteraction("a.md", 1, {
        type: "comment_focused", commentId: `c${i}`,
      });
    }
    expect(tracker.snapshot()).toHaveLength(25);
  });

  test("criterion events reach the raw log as hash keys, never text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-criterion-"));
    dirs.push(dir);
    let id = 0;
    const logger = new InteractionLogger(dir, () => 1_000, undefined, () => `e${++id}`);
    const tracker = new InteractionTracker(logger, () => 1_000, () => `s${++id}`);
    await tracker.init();
    const text = "#C9 @human The login page reads well at mobile widths";
    await tracker.trackClientInteraction("a.md", 1, {
      type: "criterion_set",
      checklistOrd: 0,
      criterionKey: criterionKey(text),
      isHuman: isHumanCriterion(text),
      checked: true,
    });
    const raw = await readFile(join(dir, "logs", "interactions.jsonl"), "utf8");
    const record = JSON.parse(raw.trim());
    expect(record).toMatchObject({
      type: "criterion_set", checklistOrd: 0, isHuman: true, checked: true,
      criterionKey: criterionKey(text),
    });
    expect(raw).not.toContain("login page");
    expect(raw).not.toContain("mobile widths");
    expect(raw).not.toContain("@human");
  });

  test("writes a parseable, content-free full lifecycle to a fresh Waypoint directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-cycle-"));
    dirs.push(dir);
    let now = 2_000;
    let id = 0;
    const logger = new InteractionLogger(dir, () => now, undefined, () => `id-${++id}`);
    const tracker = new InteractionTracker(logger, () => now, () => `session-${++id}`);
    await tracker.init();
    await tracker.planCreated("cycle.md", 1, 1_900);
    await tracker.setVisible(true);
    await tracker.selectPlan("cycle.md", 1, "auto_open", 1_900);
    now += 20;
    await tracker.setVisible(false);
    now += 100;
    await tracker.setVisible(true);
    await tracker.trackClientInteraction("cycle.md", 1, {
      type: "comment_created", commentId: "comment-1", commentCount: 1, commentCreatedAt: now,
    });
    now += 10;
    await tracker.reviewSent("cycle.md", 1, [{ createdAt: now - 10 }], true);
    await tracker.selectPlan("cycle.md", 2, "reload", 1_900);
    now += 15;
    await tracker.reviewSent("cycle.md", 2, [], true);
    await tracker.selectPlan("cycle.md", 3, "reload", 1_900);
    now += 5;
    await tracker.planAccepted("cycle.md", 3, 2, true);

    const raw = await readFile(join(dir, "logs", "interactions.jsonl"), "utf8");
    const records = raw.trim().split("\n").map(JSON.parse);
    expect(records.map((record) => record.type)).toContain("plan_accepted");
    expect(records.filter((record) => record.type === "review_sent").map((record) => record.iteration))
      .toEqual([1, 2]);
    expect(raw).not.toContain("plan markdown");
    expect(raw).not.toContain("highlighted quote");
    expect(raw).not.toContain("comment body");
    expect(records.every((record) => record.plan === "cycle.md")).toBe(true);
  });
});

// The watcher's create-versus-change classification is not a fact about the
// plan, so the host routes through `recordPlanFileEvent` instead. These drive
// that production path directly — the host only adds the `stat` around it.
describe("plan file events", () => {
  const types = (tracker: InteractionTracker) =>
    tracker
      .snapshot()
      .filter((e) => e.type === "plan_created" || e.type === "plan_updated")
      .map((e) => e.type);

  test("an atomic rewrite (delete then create) logs exactly one plan_updated", async () => {
    const { tracker } = await harness();
    const lastMtime = new Map<string, number>();
    // The agent writes the plan for the first time.
    await recordPlanFileEvent(tracker, lastMtime, "p.md", 1, 1_000);
    // It then rewrites it atomically: VS Code reports delete + create, and the
    // delete drops the cached mtime exactly as the host's onDidDelete does.
    lastMtime.delete("p.md");
    await recordPlanFileEvent(tracker, lastMtime, "p.md", 2, 2_000);
    expect(types(tracker)).toEqual(["plan_created", "plan_updated"]);
  });

  test("a duplicate event at the same mtime logs nothing", async () => {
    const { tracker } = await harness();
    const lastMtime = new Map<string, number>();
    await recordPlanFileEvent(tracker, lastMtime, "p.md", 1, 1_000);
    await recordPlanFileEvent(tracker, lastMtime, "p.md", 2, 2_000);
    const again = await recordPlanFileEvent(tracker, lastMtime, "p.md", 2, 2_000);
    expect(again).toBe("none");
    expect(types(tracker)).toEqual(["plan_created", "plan_updated"]);
  });

  test("each write of a send-back cycle is logged, not swallowed", async () => {
    const { tracker } = await harness();
    const lastMtime = new Map<string, number>();
    await recordPlanFileEvent(tracker, lastMtime, "p.md", 1, 1_000);
    // Two regeneration rounds, each arriving as a create after a rename.
    for (const [version, mtime] of [[2, 2_000], [3, 3_000]] as const) {
      lastMtime.delete("p.md");
      await recordPlanFileEvent(tracker, lastMtime, "p.md", version, mtime);
    }
    expect(types(tracker)).toEqual([
      "plan_created",
      "plan_updated",
      "plan_updated",
    ]);
    // The mtimes are the file's, so "v2 finished" is recoverable from the log.
    expect(
      tracker
        .snapshot()
        .filter((e) => e.type === "plan_updated")
        .map((e: any) => e.mtimeMs),
    ).toEqual([2_000, 3_000]);
  });

  test("regeneration_finished measures from this plan's latest review_sent", async () => {
    const { tracker, tick } = await harness();
    await tracker.selectPlan("p.md", 1, "selection", 900);
    await tracker.reviewSent("p.md", 1, [], true);
    tick(90_000);
    await tracker.regenerationFinished("p.md", 2, 5_000);
    const done: any = tracker
      .snapshot()
      .find((e) => e.type === "regeneration_finished");
    expect(done.reviewSentToDoneMs).toBe(90_000);
    expect(done.mtimeMs).toBe(5_000);
    expect(done.abandoned).toBe(false);
  });

  test("a second round measures from the second send, not the first", async () => {
    const { tracker, tick } = await harness();
    await tracker.selectPlan("p.md", 1, "selection", 900);
    await tracker.reviewSent("p.md", 1, [], true);
    tick(10_000);
    await tracker.regenerationFinished("p.md", 2, 2_000);
    tick(50_000);
    await tracker.reviewSent("p.md", 2, [], true);
    tick(7_000);
    await tracker.regenerationFinished("p.md", 3, 3_000);
    expect(
      tracker
        .snapshot()
        .filter((e) => e.type === "regeneration_finished")
        .map((e: any) => e.reviewSentToDoneMs),
    ).toEqual([10_000, 7_000]);
  });

  test("an abandoned wait is logged as such, not silently dropped", async () => {
    const { tracker, tick } = await harness();
    await tracker.selectPlan("p.md", 1, "selection", 900);
    await tracker.reviewSent("p.md", 1, [], true);
    tick(300_000);
    await tracker.regenerationFinished("p.md", 2, 0, { abandoned: true });
    const done: any = tracker
      .snapshot()
      .find((e) => e.type === "regeneration_finished");
    expect(done.abandoned).toBe(true);
    expect(done.reviewSentToDoneMs).toBe(300_000);
    // Nothing was written, so nothing changed, and no agent said otherwise.
    expect(done.changed).toBe(false);
    expect(done.signalled).toBe(false);
  });

  test("a signalled no-change finish is distinguishable from a timeout", async () => {
    const { tracker, tick } = await harness();
    await tracker.selectPlan("p.md", 1, "selection", 900);
    await tracker.reviewSent("p.md", 1, [], true);
    tick(4_000);
    await tracker.regenerationFinished("p.md", 2, 0, {
      signalled: true,
      changed: false,
    });
    const done: any = tracker
      .snapshot()
      .find((e) => e.type === "regeneration_finished");
    expect(done).toMatchObject({ abandoned: false, signalled: true, changed: false });
    expect(done.reviewSentToDoneMs).toBe(4_000);
  });

  test("two plans do not shadow each other's mtimes", async () => {
    const { tracker } = await harness();
    const lastMtime = new Map<string, number>();
    await recordPlanFileEvent(tracker, lastMtime, "a.md", 1, 5_000);
    await recordPlanFileEvent(tracker, lastMtime, "b.md", 1, 1_000);
    // b's lower mtime must not be read against a's cached value.
    expect(await recordPlanFileEvent(tracker, lastMtime, "b.md", 2, 2_000)).toBe(
      "updated",
    );
  });
});
