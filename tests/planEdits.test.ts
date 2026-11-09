import { describe, expect, test } from "bun:test";
import { diffPlanEdits } from "../src/shared/planEdits";

const PLAN = [
  "# Add OAuth login",
  "",
  "## Context",
  "",
  "The login page uses session cookies.",
  "",
  "## Phase 1: Token exchange",
  "",
  "Swap the cookie for a token.",
  "",
  "### Phase 1 acceptance gate",
  "",
  ":::checklist",
  "- [ ] #C1 `bun test tests/auth` exits 0.",
  "- [ ] #C2 @human Open /login and confirm the redirect lands on /home.",
  ":::",
  "",
  "## Verification",
  "",
  "Run the suite.",
].join("\n");

const edit = (from: string, to: string) => PLAN.replace(from, to);

describe("diffPlanEdits", () => {
  test("no baseline and an unchanged plan both mean no edits", () => {
    expect(diffPlanEdits("", PLAN)).toEqual([]);
    expect(diffPlanEdits(PLAN, PLAN)).toEqual([]);
  });

  test("a prose rewrite reports both sides under its heading", () => {
    const edits = diffPlanEdits(
      PLAN,
      edit("Swap the cookie for a token.", "Swap the cookie for an opaque token."),
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({
      kind: "prose",
      section: "Phase 1: Token exchange",
      removed: ["Swap the cookie for a token."],
      added: ["Swap the cookie for an opaque token."],
    });
  });

  test("an added criterion is a gate change, not prose", () => {
    const edits = diffPlanEdits(
      PLAN,
      edit(":::\n\n## Verification", "- [ ] #C3 `./smoke.sh` prints ok.\n:::\n\n## Verification"),
    );
    expect(edits).toHaveLength(1);
    expect(edits[0].kind).toBe("criterion");
    expect(edits[0].removed).toEqual([]);
    expect(edits[0].added).toEqual(["- [ ] #C3 `./smoke.sh` prints ok."]);
    expect(edits[0].section).toBe("Phase 1 acceptance gate");
  });

  test("a removed criterion is a gate change with an empty added side", () => {
    const edits = diffPlanEdits(
      PLAN,
      edit("- [ ] #C1 `bun test tests/auth` exits 0.\n", ""),
    );
    expect(edits).toHaveLength(1);
    expect(edits[0].kind).toBe("criterion");
    expect(edits[0].added).toEqual([]);
    expect(edits[0].removed).toEqual(["- [ ] #C1 `bun test tests/auth` exits 0."]);
  });

  test("ticking a box carries no review intent and is dropped", () => {
    const ticked = edit("- [ ] #C2 @human", "- [x] #C2 @human");
    expect(diffPlanEdits(PLAN, ticked)).toEqual([]);
  });

  test("a tick alongside a real edit still reports the real edit", () => {
    const both = edit("- [ ] #C2 @human", "- [x] #C2 @human").replace(
      "Run the suite.",
      "Run the suite twice.",
    );
    const edits = diffPlanEdits(PLAN, both);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ kind: "prose", section: "Verification" });
  });

  test("text appended at the end of the plan is reported", () => {
    const edits = diffPlanEdits(PLAN, PLAN + "\n\nAnd check the logs.");
    expect(edits).toHaveLength(1);
    expect(edits[0].added).toEqual(["And check the logs."]);
    expect(edits[0].section).toBe("Verification");
  });

  test("a heading inside a code fence does not become a section", () => {
    const fenced = ["# Title", "", "```sh", "# not a heading", "```", "", "body"].join("\n");
    const edits = diffPlanEdits(fenced, fenced.replace("body", "new body"));
    expect(edits[0].section).toBe("Title");
  });

  test("an edit that spans prose and a criterion is reported as prose, whole", () => {
    const edits = diffPlanEdits(
      PLAN,
      edit(
        "Swap the cookie for a token.\n\n### Phase 1 acceptance gate\n\n:::checklist\n- [ ] #C1 `bun test tests/auth` exits 0.",
        "Drop the cookie entirely.\n\n### Phase 1 acceptance gate\n\n:::checklist\n- [ ] #C1 `bun test tests/auth --all` exits 0.",
      ),
    );
    expect(edits.map((e) => e.kind)).toContain("prose");
  });
});
