import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanStore } from "../src/extension/planStore";
import type { Comment } from "../src/shared/review";

let dir: string;
async function makeStore(): Promise<PlanStore> {
  dir = await mkdtemp(join(tmpdir(), "waypoint-store-"));
  const store = new PlanStore(dir);
  await store.init();
  await mkdir(store.plansDir, { recursive: true });
  return store;
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const comment = (over: Partial<Comment>): Comment => ({
  id: "c1",
  quote: "quoted text",
  start: 5,
  end: 16,
  body: "a comment",
  createdAt: 1700000000000,
  ...over,
});

describe("comment persistence", () => {
  test("verdict records round-trip through the comments file", async () => {
    const store = await makeStore();
    const verdict = comment({
      id: "v1",
      body: "",
      kind: "verdict",
      verdict: "reject",
      callout: "assumption:2",
    });
    const plain = comment({ id: "c2" });
    await store.writeComments("plan.md", [verdict, plain]);
    const read = await store.readComments("plan.md");
    expect(read).toHaveLength(2);
    const v = read.find((c) => c.id === "v1")!;
    expect(v.kind).toBe("verdict");
    expect(v.verdict).toBe("reject");
    expect(v.callout).toBe("assumption:2");
    expect(v.body).toBe("");
    const p = read.find((c) => c.id === "c2")!;
    expect(p.kind).toBeUndefined();
    expect(p.body).toBe("a comment");
  });

  test("crossCutting comments round-trip through the comments file", async () => {
    const store = await makeStore();
    await store.writeComments("plan.md", [
      comment({ id: "cc1", body: "Rename everywhere.", crossCutting: true }),
      comment({ id: "c2" }),
    ]);
    const read = await store.readComments("plan.md");
    expect(read.find((c) => c.id === "cc1")?.crossCutting).toBe(true);
    expect(read.find((c) => c.id === "c2")?.crossCutting).toBeUndefined();
  });

  test("a comments file from the previous build (no extras) still parses", async () => {
    const store = await makeStore();
    const old =
      `<!-- waypoint:comments slug=plan version=1 -->\n` +
      `\n<!-- c id=old1 start=5 end=16 created=1700000000000 -->\n` +
      `> quoted text\n\n` +
      `legacy comment body\n`;
    await writeFile(join(store.plansDir, ".comments", "plan.md"), old);
    const read = await store.readComments("plan.md");
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({
      id: "old1",
      start: 5,
      end: 16,
      quote: "quoted text",
      body: "legacy comment body",
    });
    expect(read[0].kind).toBeUndefined();
  });

  test("sealing snapshots verdicts and clears the active file", async () => {
    const store = await makeStore();
    await writeFile(join(store.plansDir, "plan.md"), "# Plan\n");
    await store.writeComments("plan.md", [
      comment({ id: "v1", body: "", kind: "verdict", verdict: "accept", callout: "decision:1" }),
    ]);
    const sealed = await store.sealCurrent("plan.md");
    expect(sealed).toBe(1);
    expect(await store.readComments("plan.md")).toHaveLength(0);
    const past = await store.getVersion("plan.md", 1);
    expect(past.comments).toHaveLength(1);
    expect(past.comments[0]).toMatchObject({
      kind: "verdict",
      verdict: "accept",
      callout: "decision:1",
      resolved: true,
    });
  });
});

describe("version notes", () => {
  test("a seal with a note records why the version was superseded", async () => {
    const store = await makeStore();
    await writeFile(join(store.plansDir, "plan.md"), "# Plan\n");
    await store.sealCurrent("plan.md", "Sent back for revision with 2 comments.");
    expect(await store.listVersions("plan.md")).toEqual([
      { n: 1, current: false, note: "Sent back for revision with 2 comments." },
      { n: 2, current: true },
    ]);
    expect((await store.getVersion("plan.md", 1)).note).toBe(
      "Sent back for revision with 2 comments.",
    );
    expect((await store.getVersion("plan.md", 2)).note).toBeUndefined();
  });

  test("a seal without a note leaves no note file, and reads back as none", async () => {
    const store = await makeStore();
    await writeFile(join(store.plansDir, "plan.md"), "# Plan\n");
    await store.sealCurrent("plan.md");
    expect(await store.listVersions("plan.md")).toEqual([
      { n: 1, current: false },
      { n: 2, current: true },
    ]);
    expect(await store.readVersionNote("plan.md", 1)).toBe("");
  });

  test("the note file is one trimmed line beside the snapshot", async () => {
    const store = await makeStore();
    await writeFile(join(store.plansDir, "plan.md"), "# Plan\n");
    await store.sealCurrent("plan.md", "  why  ");
    expect(await readFile(join(store.versionsDir, "plan", "v1.note.md"), "utf8")).toBe("why\n");
  });
});

describe("checklist write-through", () => {
  const PLAN = [
    "# Plan",
    "",
    "## Phase 1: One",
    "",
    ":::checklist",
    "- [ ] first criterion",
    "- [x] done criterion",
    ":::",
    "",
    "## Phase 2: Two",
    "",
    ":::checklist",
    "- [ ] second gate item",
    "- [ ] @human Looks right in the viewer.",
    ":::",
    "",
  ].join("\n");

  async function planWith(store: PlanStore): Promise<string> {
    const p = join(store.plansDir, "plan.md");
    await writeFile(p, PLAN);
    return p;
  }

  test("add inserts before the closing ::: of the ord-th checklist", async () => {
    const store = await makeStore();
    const p = await planWith(store);
    expect(await store.editChecklist("plan.md", 1, "add", "new criterion")).toBe(true);
    const text = await readFile(p, "utf8");
    expect(text).toContain(
      "- [ ] @human Looks right in the viewer.\n- [ ] new criterion\n:::",
    );
    // The first checklist is untouched.
    expect(text).toContain("- [x] done criterion\n:::");
  });

  test("remove deletes exactly the matching line", async () => {
    const store = await makeStore();
    const p = await planWith(store);
    expect(await store.editChecklist("plan.md", 0, "remove", "first criterion")).toBe(true);
    const text = await readFile(p, "utf8");
    expect(text).not.toContain("first criterion");
    expect(text).toContain("- [x] done criterion");
    expect(text.split("\n").length).toBe(PLAN.split("\n").length - 1);
  });

  test("set flips the checkbox of an @human line (raw text with marker)", async () => {
    const store = await makeStore();
    const p = await planWith(store);
    expect(
      await store.editChecklist("plan.md", 1, "set", "@human Looks right in the viewer.", true),
    ).toBe(true);
    expect(await readFile(p, "utf8")).toContain(
      "- [x] @human Looks right in the viewer.",
    );
    expect(
      await store.editChecklist("plan.md", 1, "set", "@human Looks right in the viewer.", false),
    ).toBe(true);
    expect(await readFile(p, "utf8")).toContain(
      "- [ ] @human Looks right in the viewer.",
    );
  });

  test("missing ord or unmatched text is a no-op returning false", async () => {
    const store = await makeStore();
    const p = await planWith(store);
    expect(await store.editChecklist("plan.md", 5, "add", "x")).toBe(false);
    expect(await store.editChecklist("plan.md", 0, "remove", "no such line")).toBe(false);
    expect(await readFile(p, "utf8")).toBe(PLAN);
  });

  // Plans are hard-wrapped, so a criterion routinely spans several source
  // lines. The write-through addresses it by the joined text the viewer shows.
  const WRAPPED = [
    "# Plan",
    "",
    "## Phase 1: One",
    "",
    ":::checklist",
    "- [ ] #C1 Open the login page at phone width; confirm no label",
    "      truncates and the submit button stays visible.",
    "  evidence: checked on iPhone SE.",
    "- [ ] #C2 plain criterion",
    ":::",
    "",
  ].join("\n");
  const WRAPPED_TEXT =
    "#C1 Open the login page at phone width; confirm no label truncates and the submit button stays visible.";

  async function wrappedPlan(store: PlanStore): Promise<string> {
    const p = join(store.plansDir, "plan.md");
    await writeFile(p, WRAPPED);
    return p;
  }

  test("remove of a wrapped criterion leaves no orphaned continuation line", async () => {
    const store = await makeStore();
    const p = await wrappedPlan(store);
    expect(await store.editChecklist("plan.md", 0, "remove", WRAPPED_TEXT)).toBe(
      true,
    );
    const text = await readFile(p, "utf8");
    expect(text).not.toContain("Open the login page");
    expect(text).not.toContain("truncates and the submit button");
    expect(text).not.toContain("evidence: checked on iPhone SE.");
    // The neighbour survives, and nothing is left dangling above it.
    expect(text).toContain("- [ ] #C2 plain criterion");
    expect(text).toContain(":::checklist\n- [ ] #C2 plain criterion\n:::");
  });

  test("set flips a wrapped criterion's box and keeps its wrapping", async () => {
    const store = await makeStore();
    const p = await wrappedPlan(store);
    expect(
      await store.editChecklist("plan.md", 0, "set", WRAPPED_TEXT, true),
    ).toBe(true);
    const text = await readFile(p, "utf8");
    expect(text).toContain(
      "- [x] #C1 Open the login page at phone width; confirm no label\n      truncates and the submit button stays visible.",
    );
    expect(text).toContain("  evidence: checked on iPhone SE.");
  });

  test("a wrapped criterion cannot be addressed by its first line alone", async () => {
    const store = await makeStore();
    const p = await wrappedPlan(store);
    expect(
      await store.editChecklist(
        "plan.md",
        0,
        "remove",
        "#C1 Open the login page at phone width; confirm no label",
      ),
    ).toBe(false);
    expect(await readFile(p, "utf8")).toBe(WRAPPED);
  });

  test("adding a criterion opens the redline baseline, like a prose edit", async () => {
    const store = await makeStore();
    await planWith(store);
    expect(await store.readBaseline("plan.md")).toBe("");
    await store.editChecklist("plan.md", 1, "add", "#C9 `./smoke.sh` prints ok.");
    expect(await store.readBaseline("plan.md")).toBe(PLAN);

    const edits = await store.planEdits("plan.md");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      kind: "criterion",
      added: ["- [ ] #C9 `./smoke.sh` prints ok."],
      removed: [],
    });
  });

  test("removing a criterion opens the baseline too", async () => {
    const store = await makeStore();
    await planWith(store);
    await store.editChecklist("plan.md", 0, "remove", "first criterion");
    expect(await store.readBaseline("plan.md")).toBe(PLAN);
    expect(await store.planEdits("plan.md")).toMatchObject([
      { kind: "criterion", removed: ["- [ ] first criterion"], added: [] },
    ]);
  });

  test("ticking a box is sign-off, not a review change: no baseline, no edit", async () => {
    const store = await makeStore();
    await planWith(store);
    await store.editChecklist("plan.md", 1, "set", "@human Looks right in the viewer.", true);
    expect(await store.readBaseline("plan.md")).toBe("");
    expect(await store.planEdits("plan.md")).toEqual([]);
  });

  test("a tick after a real gate change does not add an edit of its own", async () => {
    const store = await makeStore();
    await planWith(store);
    await store.editChecklist("plan.md", 1, "add", "#C9 new gate.");
    await store.editChecklist("plan.md", 1, "set", "@human Looks right in the viewer.", true);
    const edits = await store.planEdits("plan.md");
    expect(edits).toHaveLength(1);
    expect(edits[0].added).toEqual(["- [ ] #C9 new gate."]);
  });

  test("a failed criterion edit leaves no baseline behind", async () => {
    const store = await makeStore();
    await planWith(store);
    expect(await store.editChecklist("plan.md", 0, "remove", "no such line")).toBe(false);
    expect(await store.readBaseline("plan.md")).toBe("");
  });

  const TOKEN_PLAN = [
    "# Plan",
    "",
    "## Phase 1: One",
    "",
    ":::checklist",
    "- [ ] #C1 @human Chips legible in both themes.",
    "- [x] #C2 e2e suite green.",
    "  override: flaky upstream fixture; green locally 3x.",
    "- [ ] #C3 last criterion",
    ":::",
    "",
  ].join("\n");

  async function tokenPlanWith(store: PlanStore): Promise<string> {
    const p = join(store.plansDir, "plan.md");
    await writeFile(p, TOKEN_PLAN);
    return p;
  }

  test("set flips a criterion carrying #C1 and @human without altering its text", async () => {
    const store = await makeStore();
    const p = await tokenPlanWith(store);
    expect(
      await store.editChecklist(
        "plan.md",
        0,
        "set",
        "#C1 @human Chips legible in both themes.",
        true,
      ),
    ).toBe(true);
    const text = await readFile(p, "utf8");
    expect(text).toContain("- [x] #C1 @human Chips legible in both themes.");
    expect(text).toBe(
      TOKEN_PLAN.replace(
        "- [ ] #C1 @human Chips legible in both themes.",
        "- [x] #C1 @human Chips legible in both themes.",
      ),
    );
  });

  test("remove deletes the criterion and its override: continuation line", async () => {
    const store = await makeStore();
    const p = await tokenPlanWith(store);
    expect(
      await store.editChecklist("plan.md", 0, "remove", "#C2 e2e suite green."),
    ).toBe(true);
    const text = await readFile(p, "utf8");
    expect(text).not.toContain("#C2 e2e suite green.");
    expect(text).not.toContain("override: flaky upstream fixture");
    // Neighbors are untouched.
    expect(text).toContain("- [ ] #C1 @human Chips legible in both themes.");
    expect(text).toContain("- [ ] #C3 last criterion");
  });

  test("remove also splices evidence: continuation lines", async () => {
    const store = await makeStore();
    const p = join(store.plansDir, "plan.md");
    await writeFile(
      p,
      [
        "# Plan",
        "",
        ":::checklist",
        "- [x] #C1 tests pass.",
        "  evidence: bun test exited 0.",
        "  override: recorded anyway.",
        "- [ ] #C2 next.",
        ":::",
        "",
      ].join("\n"),
    );
    expect(await store.editChecklist("plan.md", 0, "remove", "#C1 tests pass.")).toBe(true);
    const text = await readFile(p, "utf8");
    expect(text).not.toContain("evidence: bun test exited 0.");
    expect(text).not.toContain("override: recorded anyway.");
    expect(text).toContain("- [ ] #C2 next.");
  });

  test("add still inserts before the closing ::: after a note line", async () => {
    const store = await makeStore();
    const p = await tokenPlanWith(store);
    expect(await store.editChecklist("plan.md", 0, "add", "new criterion")).toBe(
      true,
    );
    expect(await readFile(p, "utf8")).toContain(
      "- [ ] #C3 last criterion\n- [ ] new criterion\n:::",
    );
  });
});

describe("inline text write-through", () => {
  const PLAN = "# Title\n\nThe quick brown fox.\n";

  async function planWith(store: PlanStore, body = PLAN): Promise<string> {
    const p = join(store.plansDir, "plan.md");
    await writeFile(p, body);
    return p;
  }

  test("splices only the requested bytes", async () => {
    const store = await makeStore();
    const p = await planWith(store);
    const start = PLAN.indexOf("quick");
    const res = await store.editText("plan.md", start, start + 5, "quick", "slow");
    expect(res.ok).toBe(true);
    expect(res.markdown).toBe("# Title\n\nThe slow brown fox.\n");
    expect(await readFile(p, "utf8")).toBe("# Title\n\nThe slow brown fox.\n");
  });

  test("refuses the edit when the file moved underneath", async () => {
    const store = await makeStore();
    const p = await planWith(store);
    const start = PLAN.indexOf("quick");
    await writeFile(p, "# Title\n\nThe agent rewrote this line.\n");

    const res = await store.editText("plan.md", start, start + 5, "quick", "slow");
    expect(res.ok).toBe(false);
    // The caller gets what the file actually says, so it can re-sync.
    expect(res.markdown).toBe("# Title\n\nThe agent rewrote this line.\n");
    expect(await readFile(p, "utf8")).toBe("# Title\n\nThe agent rewrote this line.\n");
  });

  test("out-of-range offsets are refused, not clamped", async () => {
    const store = await makeStore();
    await planWith(store);
    expect((await store.editText("plan.md", 5, 4, "", "x")).ok).toBe(false);
    expect((await store.editText("plan.md", 0, 9999, PLAN, "x")).ok).toBe(false);
    expect((await store.editText("plan.md", -1, 2, "# ", "x")).ok).toBe(false);
  });

  test("the first edit of a round snapshots the redline baseline", async () => {
    const store = await makeStore();
    await planWith(store);
    expect(await store.readBaseline("plan.md")).toBe("");

    const start = PLAN.indexOf("quick");
    await store.editText("plan.md", start, start + 5, "quick", "slow");
    expect(await store.readBaseline("plan.md")).toBe(PLAN);

    // A second edit keeps the original baseline — the redline accumulates
    // across the whole round rather than resetting on every keystroke.
    const next = "# Title\n\nThe slow brown fox.\n".indexOf("brown");
    await store.editText("plan.md", next, next + 5, "brown", "red");
    expect(await store.readBaseline("plan.md")).toBe(PLAN);
  });

  test("a refused edit leaves no baseline behind", async () => {
    const store = await makeStore();
    await planWith(store);
    expect((await store.editText("plan.md", 0, 5, "wrong", "x")).ok).toBe(false);
    expect(await store.readBaseline("plan.md")).toBe("");
  });

  test("sealing the version clears the baseline", async () => {
    const store = await makeStore();
    await planWith(store);
    const start = PLAN.indexOf("quick");
    await store.editText("plan.md", start, start + 5, "quick", "slow");
    expect(await store.readBaseline("plan.md")).not.toBe("");

    await store.sealCurrent("plan.md");
    expect(await store.readBaseline("plan.md")).toBe("");
  });

  test("baselines live outside the watched plan glob", async () => {
    const store = await makeStore();
    await planWith(store);
    const start = PLAN.indexOf("quick");
    await store.editText("plan.md", start, start + 5, "quick", "slow");
    // The watcher pattern is `<plansDir>/*.md`, non-recursive — a baseline in a
    // subdirectory never echoes back as a plan change.
    expect(store.editsDir).toBe(join(store.plansDir, ".edits"));
    expect((await store.listPlans()).map((p) => p.name)).toEqual(["plan.md"]);
  });
});

// A review file is the only record of what the reviewer asked for: the
// interaction log is content-free, and `sealCurrent` clears the baseline the
// "direct plan edits" section was derived from. So the round retires it into
// the sealed version rather than deleting it.
describe("archiveReview", () => {
  async function sentReview(store: PlanStore) {
    await writeFile(join(store.plansDir, "plan.md"), "# Plan\n\nBody.\n");
    await store.writeComments("plan.md", [comment({ body: "please fix" })]);
    const { path, prompt } = await store.writeReview("plan.md");
    const sealed = await store.sealCurrent("plan.md");
    return { path, prompt, sealed };
  }

  test("files the review beside its version, byte-identical", async () => {
    const store = await makeStore();
    const { path, prompt, sealed } = await sentReview(store);
    const to = await store.archiveReview("plan.md", sealed);
    expect(to).toBe(join(store.versionsDir, "plan", `v${sealed}.review.md`));
    expect(await readFile(to!, "utf8")).toBe(prompt);
    // Gone from plans/, so the next round starts clean.
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  test("the round's three artifacts end up sharing one stem", async () => {
    const store = await makeStore();
    const { sealed } = await sentReview(store);
    await store.archiveReview("plan.md", sealed);
    const dir = join(store.versionsDir, "plan");
    for (const suffix of [".md", ".comments.md", ".review.md"])
      expect(await readFile(join(dir, `v${sealed}${suffix}`), "utf8")).toBeTruthy();
  });

  test("archiving twice is a no-op, not a failure", async () => {
    const store = await makeStore();
    const { sealed } = await sentReview(store);
    const first = await store.archiveReview("plan.md", sealed);
    expect(first).not.toBeNull();
    expect(await store.archiveReview("plan.md", sealed)).toBeNull();
    // The first archive is left intact by the second call.
    expect(await readFile(first!, "utf8")).toContain("please fix");
  });

  test("a round with no review file archives nothing", async () => {
    const store = await makeStore();
    await writeFile(join(store.plansDir, "plan.md"), "# Plan\n");
    expect(await store.archiveReview("plan.md", 1)).toBeNull();
  });

  test("leaves the sealed plan, its comments, and .comments/ untouched", async () => {
    const store = await makeStore();
    const { sealed } = await sentReview(store);
    const dir = join(store.versionsDir, "plan");
    const before = await Promise.all([
      readFile(join(dir, `v${sealed}.md`), "utf8"),
      readFile(join(dir, `v${sealed}.comments.md`), "utf8"),
    ]);
    await store.archiveReview("plan.md", sealed);
    expect(await readFile(join(dir, `v${sealed}.md`), "utf8")).toBe(before[0]);
    expect(await readFile(join(dir, `v${sealed}.comments.md`), "utf8")).toBe(before[1]);
    // Sealing already emptied the active comments; archiving must not revive them.
    expect(await store.readComments("plan.md")).toHaveLength(0);
  });
});
