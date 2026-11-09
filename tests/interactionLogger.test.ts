import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InteractionLogger } from "../src/extension/interactionLogger";
import {
  INTERACTION_LOG_SCHEMA_VERSION,
  assertInteractionEvent,
  type InteractionEventInput,
} from "../src/shared/interactionLog";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-log-"));
  dirs.push(dir);
  return dir;
}

const variants: InteractionEventInput[] = [
  { type: "plan_created", mtimeMs: 1 },
  { type: "plan_updated", mtimeMs: 2 },
  {
    type: "regeneration_finished",
    mtimeMs: 3,
    reviewSentToDoneMs: 120_000,
    abandoned: false,
    signalled: true,
    changed: true,
  },
  { type: "plan_view_started", sessionId: "s", trigger: "selection" },
  { type: "plan_view_ended", sessionId: "s", reason: "panel_hidden", durationMs: 3 },
  { type: "comment_created", commentId: "c", commentCount: 1, commentCreatedAt: 4 },
  { type: "comment_deleted", commentId: "c", commentCount: 0 },
  {
    type: "review_sent", iteration: 1, commentCount: 1,
    creationToActionMs: 10, latestUpdateToActionMs: 5, activeReadingMs: 7,
    firstViewToFirstCommentMs: 2, commentSpanMs: 0, terminalInjected: true,
  },
  {
    type: "plan_accepted", iterationCount: 1, creationToActionMs: 20,
    activeReadingMs: 9, terminalInjected: false,
  },
  {
    type: "plan_view_ended", sessionId: "s", reason: "window_closed",
    durationMs: 100, focusedMs: 40,
  },
  { type: "criterion_set", checklistOrd: 0, criterionKey: "ab12cd34", isHuman: true, checked: true },
  { type: "criterion_added", checklistOrd: 1, criterionKey: "ab12cd34", isHuman: false, charCount: 12 },
  { type: "criterion_removed", checklistOrd: 1, criterionKey: "ab12cd34", isHuman: false, charCount: 12 },
  {
    type: "prose_edit", sourceStart: 10, insertedChars: 5, removedChars: 2,
    flushCount: 3, durationMs: 4_000,
  },
  { type: "reflect_requested", terminalInjected: true },
  { type: "diff_view_toggled", visible: true },
  { type: "nav_jump", source: "phase_pill", targetIndex: 1 },
  { type: "comment_focused", commentId: "c" },
  { type: "comment_draft_opened", draftId: "d", quoteLength: 24 },
  { type: "comment_draft_cancelled", draftId: "d" },
  { type: "replan_modal", action: "opened" },
  { type: "plan_reopened" },
  { type: "plan_reopened", source: "new_version" },
  { type: "card_resized", widthPx: 720, previousWidthPx: 640 },
  { type: "webview_focus", focused: false },
  {
    type: "section_dwell", sectionCount: 5,
    dwells: [{ s: 0, label: "Overview", ms: 3000 }, { s: 1, label: "Phase 1", ms: 2000 }],
  },
];

describe("interaction event contract", () => {
  test("accepts every metadata-only event variant", () => {
    for (const input of variants) {
      expect(() => assertInteractionEvent({
        schemaVersion: INTERACTION_LOG_SCHEMA_VERSION,
        eventId: "e", timestamp: new Date(0).toISOString(), plan: "p.md", version: 1,
        ...input,
      })).not.toThrow();
    }
  });

  // `regeneration_finished` is the answer to a `review_sent` — the timestamp
  // that nothing else in the log records.
  test("regeneration_finished carries its turnaround and nothing else", () => {
    const base = {
      schemaVersion: INTERACTION_LOG_SCHEMA_VERSION,
      eventId: "e",
      timestamp: new Date(0).toISOString(),
      plan: "p.md",
      version: 2,
    };
    expect(() =>
      assertInteractionEvent({
        ...base,
        type: "regeneration_finished",
        mtimeMs: 3,
        reviewSentToDoneMs: 1,
        abandoned: true,
        signalled: false,
        changed: false,
      }),
    ).not.toThrow();
    // The plan's prose must never ride along on it.
    expect(() =>
      assertInteractionEvent({
        ...base,
        type: "regeneration_finished",
        mtimeMs: 3,
        reviewSentToDoneMs: 1,
        abandoned: false,
        signalled: true,
        changed: false,
        markdown: "secret",
      }),
    ).toThrow("unexpected interaction fields");
  });

  test.each(["markdown", "quote", "body", "prompt", "terminalContents"])(
    "rejects content field %s",
    (field) => expect(() => assertInteractionEvent({
      schemaVersion: 1, eventId: "e", timestamp: new Date(0).toISOString(),
      plan: "p.md", version: 1, type: "plan_created", mtimeMs: 1, [field]: "secret",
    })).toThrow("unexpected interaction fields"),
  );
});

describe("InteractionLogger", () => {
  test("creates its directory and serializes concurrent writes", async () => {
    const dir = await tempDir();
    let now = 0;
    let id = 0;
    const logger = new InteractionLogger(dir, () => ++now, undefined, () => `e${++id}`);
    await logger.init();
    await stat(join(dir, "logs"));
    await Promise.all(variants.map((event) => logger.log("p.md", 1, event)));
    const lines = (await readFile(logger.path, "utf8")).trim().split("\n").map(JSON.parse);
    expect(lines).toHaveLength(variants.length);
    expect(lines.map((line) => line.eventId)).toEqual(variants.map((_, i) => `e${i + 1}`));
    expect(lines.map((line) => Date.parse(line.timestamp))).toEqual(
      [...lines].map((_, i) => i + 1),
    );
  });

  test("swallows append failures and still resolves with the built event", async () => {
    const dir = await tempDir();
    const logger = new InteractionLogger(dir, Date.now, async () => { throw new Error("disk full"); });
    await logger.init();
    await expect(logger.log("p.md", 1, variants[0])).resolves.toMatchObject({
      type: "plan_created", plan: "p.md", version: 1,
    });
  });

  test("logSync validates and appends one line synchronously", async () => {
    const dir = await tempDir();
    const written: string[] = [];
    const logger = new InteractionLogger(
      dir, () => 5, undefined, () => "sync-1",
      (_path, data) => written.push(data),
    );
    const event = logger.logSync("p.md", 2, {
      type: "plan_view_ended", sessionId: "s", reason: "window_closed",
      durationMs: 100, focusedMs: 40,
    });
    expect(event.eventId).toBe("sync-1");
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0])).toMatchObject({
      type: "plan_view_ended", reason: "window_closed", durationMs: 100, focusedMs: 40,
      plan: "p.md", version: 2,
    });
  });
});
