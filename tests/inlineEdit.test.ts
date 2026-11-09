import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./setup-dom";
import { PlanStore } from "../src/extension/planStore";
import { parsePhases } from "../src/webview/lib/phases";
import { computeDrift } from "../src/webview/lib/drift";

const { renderMarkdown, sanitizePlanHtml } = await import(
  "../src/webview/lib/markdown"
);
const { blkRange, ownText, spliceFromEdit } = await import(
  "../src/webview/lib/srcmap"
);
const { htmldiff } = await import("../src/webview/lib/htmldiff");

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function store(plan: string): Promise<PlanStore> {
  dir = await mkdtemp(join(tmpdir(), "waypoint-edit-"));
  const s = new PlanStore(dir);
  await s.init();
  await mkdir(s.plansDir, { recursive: true });
  await writeFile(join(s.plansDir, "plan.md"), plan);
  return s;
}

function render(md: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(md);
  return el as unknown as HTMLElement;
}

/**
 * One reviewer edit, the way PlanDocument performs it: find the unit, diff its
 * rendered text, splice the source through the store.
 */
async function edit(
  s: PlanStore,
  md: string,
  selector: string,
  nth: number,
  after: string,
): Promise<{ ok: boolean; markdown: string }> {
  const unit = render(md).querySelectorAll(selector)[nth] as HTMLElement;
  const range = blkRange(unit)!;
  const splice = spliceFromEdit(
    ownText(unit),
    after,
    md.slice(range.start, range.end),
    range.start,
  );
  if (!splice) return { ok: false, markdown: md };
  return s.editText("plan.md", splice.start, splice.end, splice.expected, splice.text);
}

// A hard-wrapped paragraph carrying inline markup — the shape of real plan
// prose, and the shape that a single-line fixture cannot exercise.
const WRAPPED = [
  "Two problems, one about the viewer and one about the planner. In the",
  "viewer, a diagram wider than the card is scaled to fit, so `flowchart LR`",
  "renders at *half* the size of the **body** text around it.",
].join("\n");

const PLAN = [
  "# Ship the thing",
  "",
  "## Context",
  "",
  "Depth: Standard",
  "",
  WRAPPED,
  "",
  "## Phase 1: Build it",
  "",
  "The watcher is debounced by 120ms, which is fine.",
  "",
  "### Phase 1 acceptance gate",
  "",
  ":::checklist",
  "- [x] #C1 `bun test` exits 0.",
  "  evidence: bun test exited 0 (12 pass)",
  "- [ ] #C2 @human The login page reads well.",
  ":::",
  "",
].join("\n");

describe("a reviewer edits a plan in the viewer", () => {
  test("prose edits land as a minimal splice and nothing else moves", async () => {
    const s = await store(PLAN);
    const res = await edit(
      s,
      PLAN,
      "p",
      2,
      "The watcher is debounced by 200ms, which is fine.",
    );
    expect(res.ok).toBe(true);

    const written = await readFile(join(s.plansDir, "plan.md"), "utf8");
    expect(written).toBe(PLAN.replace("120ms", "200ms"));
  });

  test("typing into a hard-wrapped paragraph keeps its wraps and markup", async () => {
    // The regression: the old diff compared a newline-stripped new side against
    // an untouched old one, so the common prefix died at the first wrap and a
    // few typed characters rewrote the paragraph in rendered text — inline
    // markup and all.
    const s = await store(PLAN);
    const doc = render(PLAN);
    const p = doc.querySelectorAll("p")[1] as HTMLElement;
    const res = await edit(s, PLAN, "p", 1, ownText(p) + " Really.");

    expect(res.ok).toBe(true);
    const written = await readFile(join(s.plansDir, "plan.md"), "utf8");
    expect(written).toBe(PLAN.replace("around it.", "around it. Really."));
    // Every wrap and every delimiter is still there, byte for byte.
    expect(written).toContain("`flowchart LR`");
    expect(written).toContain("*half*");
    expect(written).toContain("**body**");
    expect(written.split("\n").length).toBe(PLAN.split("\n").length);
  });

  test("editing a criterion label leaves the marker, id and evidence alone", async () => {
    const s = await store(PLAN);
    const res = await edit(
      s,
      PLAN,
      ".wp-check-label",
      1,
      "The login page reads well at mobile widths.",
    );
    expect(res.ok).toBe(true);
    expect(res.markdown).toContain(
      "- [ ] #C2 @human The login page reads well at mobile widths.",
    );
    // The neighbouring criterion, its tick and its evidence line are untouched.
    expect(res.markdown).toContain("- [x] #C1 `bun test` exits 0.");
    expect(res.markdown).toContain("  evidence: bun test exited 0 (12 pass)");
  });

  test("the phase parsers still read the plan after a round of edits", async () => {
    const s = await store(PLAN);
    const before = parsePhases(PLAN);
    const a = await edit(s, PLAN, "p", 2, "The watcher is debounced by 200ms.");
    const b = await edit(
      s,
      a.markdown,
      ".wp-check-label",
      1,
      "The login page reads well at mobile widths.",
    );
    expect(b.ok).toBe(true);

    const after = parsePhases(b.markdown);
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ total: 2, checked: 1 });
    // Drift classification is unchanged: still one evidenced tick, no dangling
    // probes or duplicate IDs introduced by the edits.
    expect(computeDrift(b.markdown)).toEqual(computeDrift(PLAN));
  });

  test("edits render as redline against the round's baseline", async () => {
    const s = await store(PLAN);
    const res = await edit(
      s,
      PLAN,
      "p",
      2,
      "The watcher is debounced by 200ms, which is fine.",
    );
    const baseline = await s.readBaseline("plan.md");
    expect(baseline).toBe(PLAN);

    const doc = document.createElement("div");
    doc.innerHTML = sanitizePlanHtml(
      htmldiff(renderMarkdown(baseline), renderMarkdown(res.markdown)),
    );
    expect(doc.querySelector("del.wp-del")?.textContent).toContain("120ms");
    expect(doc.querySelector("ins.wp-ins")?.textContent).toContain("200ms");
    // The redline is a view: the file itself never grows suggestion markup.
    expect(res.markdown).not.toContain("<del");
    expect(res.markdown).not.toContain("wp-ins");
  });

  test("deleted runs stay editable-proof and out of the document's text", async () => {
    const s = await store(PLAN);
    const res = await edit(s, PLAN, "p", 2, "The watcher is debounced.");
    const baseline = await s.readBaseline("plan.md");
    const doc = document.createElement("div");
    doc.innerHTML = sanitizePlanHtml(
      htmldiff(renderMarkdown(baseline), renderMarkdown(res.markdown)),
    );

    const del = doc.querySelector("del.wp-del")!;
    expect(del.getAttribute("contenteditable")).toBe("false");
    // The unit's own text is what the plan says now, not what it used to say —
    // this is the invariant comment offsets and source alignment both rest on.
    const p = [...doc.querySelectorAll("p")].find((el) =>
      el.textContent?.includes("watcher"),
    )!;
    expect(ownText(p)).toBe("The watcher is debounced.");
  });

  test("a stale offset is refused rather than corrupting the file", async () => {
    const s = await store(PLAN);
    const unit = render(PLAN).querySelectorAll("p")[2] as HTMLElement;
    const range = blkRange(unit)!;
    const splice = spliceFromEdit(
      ownText(unit),
      "The watcher is debounced by 200ms, which is fine.",
      PLAN.slice(range.start, range.end),
      range.start,
    )!;

    // An agent rewrites the plan between the viewer's read and its write.
    await writeFile(join(s.plansDir, "plan.md"), PLAN.replace("Build it", "Build it well"));
    const res = await s.editText(
      "plan.md",
      splice.start,
      splice.end,
      splice.expected,
      splice.text,
    );
    expect(res.ok).toBe(false);
    expect(res.markdown).toContain("## Phase 1: Build it well");
    expect(res.markdown).toContain("120ms");
  });
});
