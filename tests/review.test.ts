import { describe, expect, test } from "bun:test";
import {
  applyVerdict,
  compileReview,
  isVerdict,
  shiftComments,
  type Comment,
} from "../src/shared/review";

const base = (over: Partial<Comment>): Comment => ({
  id: "c1",
  quote: "Q",
  start: 0,
  end: 1,
  body: "",
  createdAt: 1,
  ...over,
});

const anchor = { callout: "assumption:1", start: 10, end: 20, quote: "The premise." };

describe("applyVerdict", () => {
  test("creates a verdict record when none exists", () => {
    const res = applyVerdict([], { ...anchor, verdict: "accept" }, "v1", 99);
    expect(res.outcome).toBe("set");
    expect(res.comments).toHaveLength(1);
    const v = res.comments[0];
    expect(isVerdict(v)).toBe(true);
    expect(v).toMatchObject({
      id: "v1",
      body: "",
      verdict: "accept",
      callout: "assumption:1",
      start: 10,
      end: 20,
      quote: "The premise.",
      createdAt: 99,
    });
  });

  test("same verdict again clears it", () => {
    const set = applyVerdict([], { ...anchor, verdict: "accept" }, "v1", 99);
    const res = applyVerdict(set.comments, { ...anchor, verdict: "accept" }, "v2", 100);
    expect(res.outcome).toBe("cleared");
    expect(res.comments).toHaveLength(0);
  });

  test("other verdict switches in place, keeping the id", () => {
    const set = applyVerdict([], { ...anchor, verdict: "accept" }, "v1", 99);
    const res = applyVerdict(set.comments, { ...anchor, verdict: "reject" }, "v2", 100);
    expect(res.outcome).toBe("switched");
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0].id).toBe("v1");
    expect(res.comments[0].verdict).toBe("reject");
  });

  test("does not touch ordinary comments or other callouts' verdicts", () => {
    const others = [
      base({ id: "note", body: "a real comment" }),
      base({ id: "vx", kind: "verdict", verdict: "reject", callout: "decision:1" }),
    ];
    const res = applyVerdict(others, { ...anchor, verdict: "accept" }, "v1", 99);
    expect(res.comments).toHaveLength(3);
    expect(res.comments.filter(isVerdict)).toHaveLength(2);
  });
});

describe("compileReview", () => {
  test("verdicts lead in their own section with type-aware guidance", () => {
    const comments: Comment[] = [
      base({ id: "n1", quote: "Some prose.", body: "Tighten this." }),
      base({
        id: "v1",
        kind: "verdict",
        verdict: "accept",
        callout: "assumption:1",
        quote: "The premise.",
      }),
    ];
    const out = compileReview("plan.md", comments);
    expect(out).toContain("## Callout verdicts");
    expect(out).toContain("### Accepted assumption (assumption:1)");
    expect(out).toContain("> The premise.");
    expect(out).toContain("the plan may rely on it");
    // Ordinary comments keep their exact format and 1-based numbering.
    expect(out).toContain("## Comment 1");
    expect(out).toContain("Feedback: Tighten this.");
    expect(out).not.toContain("## Comment 2");
    expect(out.indexOf("## Callout verdicts")).toBeLessThan(out.indexOf("## Comment 1"));
  });

  test("an ID key surfaces the ID in the verdict header", () => {
    const out = compileReview("plan.md", [
      base({
        id: "v1",
        kind: "verdict",
        verdict: "reject",
        callout: "assumption:A3",
        quote: "The premise.",
      }),
    ]);
    expect(out).toContain("### Rejected assumption (assumption:A3)");
    expect(out).toContain("revise the plan so it no longer depends on it");
  });

  test("an unknown callout type falls back to the generic sentence", () => {
    // e.g. an ancient stored record from the retired :::validate callout.
    const out = compileReview("plan.md", [
      base({
        id: "v2",
        kind: "verdict",
        verdict: "reject",
        callout: "validate:1",
        quote: "Confirm the dividers render.",
      }),
    ]);
    expect(out).toContain("### Rejected validate (validate:1)");
    expect(out).toContain("The reviewer marked this callout as rejected.");
  });

  test("no verdicts → output matches the legacy shape", () => {
    const out = compileReview("plan.md", [
      base({ id: "n1", quote: "Q1", body: "B1" }),
    ]);
    expect(out).not.toContain("Callout verdicts");
    expect(out).toContain("# Plan refinement request");
    expect(out).toContain("## Comment 1");
  });

  test("cross-cutting comments get their own leading section with the whole-plan instruction", () => {
    const out = compileReview("plan.md", [
      base({ id: "n1", quote: "Local bit.", body: "Tighten." }),
      base({
        id: "x1",
        quote: "The retry policy.",
        body: "Rename RetryQueue everywhere.",
        crossCutting: true,
      }),
      base({ id: "n2", quote: "Other bit.", body: "Fix typo." }),
    ]);
    expect(out).toContain("## Cross-cutting comments");
    expect(out).toContain("whole-plan revision pass");
    expect(out).toContain("listing every section and callout/criterion ID");
    expect(out).toContain("### Cross-cutting comment 1");
    expect(out).toContain("> The retry policy.");
    // Cross-cutting section precedes ordinary comments; ordinary numbering
    // covers ordinary comments only.
    expect(out.indexOf("## Cross-cutting comments")).toBeLessThan(
      out.indexOf("## Comment 1"),
    );
    expect(out).toContain("## Comment 2");
    expect(out).not.toContain("## Comment 3");
  });

  test("no cross-cutting comments → no cross-cutting section", () => {
    const out = compileReview("plan.md", [base({ id: "n1", body: "B1" })]);
    expect(out).not.toContain("Cross-cutting");
  });

  test("direct edits lead, marked as already applied", () => {
    const out = compileReview(
      "plan.md",
      [base({ id: "n1", quote: "Q1", body: "B1" })],
      [
        {
          kind: "prose",
          section: "Phase 1: Token exchange",
          removed: ["Swap the cookie for a token."],
          added: ["Swap the cookie for a JWT."],
        },
      ],
    );
    expect(out).toContain("## Direct plan edits");
    expect(out).toContain("### Edit 1 — Phase 1: Token exchange");
    expect(out).toContain("> Swap the cookie for a token.");
    expect(out).toContain("> Swap the cookie for a JWT.");
    expect(out).toContain("ALREADY saved in the plan file");
    expect(out).toContain("do not re-apply it and do not revert it");
    // Already-applied changes frame the comments, so they come first.
    expect(out.indexOf("## Direct plan edits")).toBeLessThan(out.indexOf("## Comment 1"));
  });

  test("gate changes get their own section with keep/never-restore instructions", () => {
    const out = compileReview("plan.md", [], [
      {
        kind: "criterion",
        section: "Phase 2 acceptance gate",
        removed: [],
        added: ["- [ ] #C7 `./smoke.sh` prints ok."],
      },
      {
        kind: "criterion",
        section: "Phase 2 acceptance gate",
        removed: ["- [ ] #C3 handle errors."],
        added: [],
      },
    ]);
    expect(out).toContain("## Gate changes");
    expect(out).not.toContain("## Direct plan edits");
    expect(out).toContain("### Gate change 1 — Phase 2 acceptance gate");
    expect(out).toContain("Added:");
    expect(out).toContain("### Gate change 2 — Phase 2 acceptance gate");
    expect(out).toContain("Removed:");
    expect(out).toContain("make it checkable rather than dropping it");
    expect(out).toContain("do not restore a removed one");
  });

  test("no edits → output matches the comments-only shape", () => {
    const out = compileReview("plan.md", [base({ id: "n1", body: "B1" })]);
    expect(out).not.toContain("Direct plan edits");
    expect(out).not.toContain("Gate changes");
    expect(out).not.toContain("two kinds of input");
  });
});

describe("shiftComments", () => {
  const at = (start: number, end: number, over: Partial<Comment> = {}): Comment => ({
    id: `c${start}`,
    quote: "q",
    start,
    end,
    body: "b",
    createdAt: 1,
    ...over,
  });

  test("a comment above the edit is untouched — same object, no rewrite", () => {
    const c = at(0, 10);
    const out = shiftComments([c], { at: 50, removed: 3, inserted: 8 });
    expect(out[0]).toBe(c);
  });

  test("a comment below the edit slides by the delta", () => {
    const out = shiftComments([at(100, 120)], { at: 50, removed: 3, inserted: 8 });
    expect(out[0].start).toBe(105);
    expect(out[0].end).toBe(125);
    expect(out[0].stale).toBeUndefined();
  });

  test("a deletion slides following comments back", () => {
    const out = shiftComments([at(100, 120)], { at: 50, removed: 10, inserted: 0 });
    expect(out[0].start).toBe(90);
    expect(out[0].end).toBe(110);
  });

  test("a comment the edit ran through is kept and flagged stale", () => {
    const out = shiftComments([at(40, 60)], { at: 45, removed: 5, inserted: 2 });
    expect(out[0].stale).toBe(true);
    // The span still covers the reviewer's words plus what replaced them.
    expect(out[0].start).toBe(40);
    expect(out[0].end).toBe(57);
  });

  test("an edit that deletes a whole comment's span leaves a valid range", () => {
    const out = shiftComments([at(40, 60)], { at: 30, removed: 40, inserted: 0 });
    expect(out[0].stale).toBe(true);
    expect(out[0].end).toBeGreaterThanOrEqual(out[0].start);
  });

  test("an edit touching the boundary does not falsely stale a neighbour", () => {
    // A comment ending exactly where the edit starts is above it.
    expect(shiftComments([at(10, 50)], { at: 50, removed: 2, inserted: 0 })[0].stale)
      .toBeUndefined();
    // A comment starting exactly where the edit ends is below it.
    const below = shiftComments([at(52, 70)], { at: 50, removed: 2, inserted: 0 })[0];
    expect(below.stale).toBeUndefined();
    expect(below.start).toBe(50);
  });
});
