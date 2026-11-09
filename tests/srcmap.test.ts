import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./setup-dom";

// markdown.ts must be imported after the DOM globals exist — DOMPurify
// captures `window` at import time.
const { renderMarkdown } = await import("../src/webview/lib/markdown");
const {
  alignTextToSource,
  blkRange,
  delimitersBalanced,
  ownText,
  spliceFromEdit,
} = await import("../src/webview/lib/srcmap");

function render(md: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(md);
  return el as unknown as HTMLElement;
}

/** Apply a splice to the source the way PlanStore.editText will. */
function apply(md: string, s: { start: number; end: number; text: string }) {
  return md.slice(0, s.start) + s.text + md.slice(s.end);
}

describe("alignTextToSource", () => {
  test("maps rendered text through inline markup", () => {
    const map = alignTextToSource("bold text", "**bold** text")!;
    expect(map).not.toBeNull();
    expect(map[0]).toBe(2); // 'b' after the opening **
    expect(map[4]).toBe(8); // the space, after the closing **
  });

  test("skips link targets, which never surface as text", () => {
    const raw = "see [the docs](https://x.test/docs) now";
    const map = alignTextToSource("see the docs now", raw)!;
    expect(raw.slice(map[4], map[11] + 1)).toBe("the docs");
  });

  test("handles escapes and entities", () => {
    expect(alignTextToSource("a * b", "a \\* b")).not.toBeNull();
    expect(alignTextToSource("a & b", "a &amp; b")).not.toBeNull();
  });

  test("returns null when the text is not a subsequence of the source", () => {
    expect(alignTextToSource("zzz", "abc")).toBeNull();
  });
});

describe("delimitersBalanced", () => {
  test("accepts a self-contained span", () => {
    expect(delimitersBalanced("runs `foo` now")).toBe(true);
  });

  test("rejects a span holding half of a pair", () => {
    expect(delimitersBalanced("oo` now")).toBe(false);
    expect(delimitersBalanced("**bold")).toBe(false);
  });
});

describe("spliceFromEdit", () => {
  test("a typo fix touches only the changed bytes", () => {
    const md = "The quick brown fox.\n";
    const doc = render(md);
    const p = doc.querySelector("p")!;
    const range = blkRange(p)!;
    const raw = md.slice(range.start, range.end);
    const before = ownText(p);
    const s = spliceFromEdit(before, "The slow brown fox.", raw, range.start)!;

    expect(s.expected).toBe("quick");
    expect(s.text).toBe("slow");
    expect(apply(md, s)).toBe("The slow brown fox.\n");
  });

  test("an insertion at the end of a unit removes nothing", () => {
    const md = "Hello\n";
    const p = render(md).querySelector("p")!;
    const range = blkRange(p)!;
    const s = spliceFromEdit(
      ownText(p),
      "Hello there",
      md.slice(range.start, range.end),
      range.start,
    )!;
    expect(s.start).toBe(s.end);
    expect(s.text).toBe(" there");
    expect(apply(md, s)).toBe("Hello there\n");
  });

  test("edits a heading without disturbing its ## marker", () => {
    const md = "## Phase 1: Ship it\n";
    const h = render(md).querySelector("h2")!;
    const range = blkRange(h)!;
    const s = spliceFromEdit(
      ownText(h),
      "Phase 1: Ship it soon",
      md.slice(range.start, range.end),
      range.start,
    )!;
    expect(apply(md, s)).toBe("## Phase 1: Ship it soon\n");
  });

  test("declines an edit that would swallow a block boundary", () => {
    const md = "One line\nsecond line\n\n- a list item\n";
    const p = render(md).querySelector("p")!;
    const range = blkRange(p)!;
    const raw = md.slice(range.start, range.end);
    // Deleting everything but the first word crosses the soft wrap — allowed.
    expect(spliceFromEdit("One line\nsecond line", "One", raw, range.start))
      .not.toBeNull();
    // The paragraph's own range stops before the list, so the list is safe.
    expect(raw.includes("- a list item")).toBe(false);
  });

  test("declines an edit that would orphan an inline delimiter", () => {
    const md = "Call `doThing()` first.\n";
    const p = render(md).querySelector("p")!;
    const range = blkRange(p)!;
    const raw = md.slice(range.start, range.end);
    // Deleting from inside the code span out past it would swallow the closing
    // backtick and leave the opening one dangling in the file.
    expect(spliceFromEdit(ownText(p), "Call doThing.", raw, range.start))
      .toBeNull();
    // Staying inside the code span is fine.
    const inside = spliceFromEdit(
      ownText(p),
      "Call doThing(x) first.",
      raw,
      range.start,
    )!;
    expect(apply(md, inside)).toBe("Call `doThing(x)` first.\n");
  });

  test("returns null when nothing changed", () => {
    expect(spliceFromEdit("same", "same", "same", 0)).toBeNull();
  });
});

// Plan prose is hard-wrapped, so a unit's rendered text routinely contains
// newlines and inline markup. Every case here is one a single-line fixture
// cannot reach.
describe("hard-wrapped prose", () => {
  const md =
    "Two problems, one about the viewer and one about the planner. In the\n" +
    "viewer, a diagram wider than the card is scaled to fit, so `flowchart LR`\n" +
    "renders at *half* the size of the **body** text around it.\n";

  function unit() {
    const p = render(md).querySelector("p")!;
    return { p, range: blkRange(p)!, before: ownText(p) };
  }

  test("the rendered text really does span several source lines", () => {
    expect(unit().before).toContain("\n");
  });

  test("typing at the end appends, and rewrites nothing else", () => {
    const { range, before } = unit();
    const s = spliceFromEdit(
      before,
      before + " Really.",
      md.slice(range.start, range.end),
      range.start,
    )!;
    expect(s.expected).toBe("");
    expect(s.text).toBe(" Really.");
    // The wraps and every inline delimiter survive untouched.
    expect(apply(md, s)).toBe(md.replace("around it.", "around it. Really."));
  });

  test("editing the first line leaves the later lines and their markup alone", () => {
    const { range, before } = unit();
    const s = spliceFromEdit(
      before,
      before.replace("Two problems", "Three problems"),
      md.slice(range.start, range.end),
      range.start,
    )!;
    // Minimal to the character: "T" is common, so only "wo" is replaced.
    expect(s.expected).toBe("wo");
    expect(s.text).toBe("hree");
    expect(apply(md, s)).toBe(md.replace("Two problems", "Three problems"));
  });

  test("editing after a wrap does not collapse the paragraph", () => {
    const { range, before } = unit();
    const s = spliceFromEdit(
      before,
      before.replace("scaled to fit", "scaled down to fit"),
      md.slice(range.start, range.end),
      range.start,
    )!;
    const out = apply(md, s);
    expect(out).toBe(md.replace("scaled to fit", "scaled down to fit"));
    // The three source lines are still three source lines.
    expect(out.split("\n").length).toBe(md.split("\n").length);
  });

  test("an edit spanning inline markup is declined, not flattened", () => {
    const { range, before } = unit();
    // This is the regression: the replacement would be rendered text, so
    // `flowchart LR`, *half* and **body** would all come back unmarked.
    const s = spliceFromEdit(
      before,
      before.replace(/so .*around it\./s, "so nothing else."),
      md.slice(range.start, range.end),
      range.start,
    );
    expect(s).toBeNull();
  });

  test("markup elsewhere in the unit never reaches the replacement text", () => {
    const { range, before } = unit();
    const s = spliceFromEdit(
      before,
      before.replace("viewer, a diagram", "viewer, one diagram"),
      md.slice(range.start, range.end),
      range.start,
    )!;
    for (const marker of ["`", "*", "**"]) expect(s.text).not.toContain(marker);
    expect(apply(md, s)).toContain("`flowchart LR`");
    expect(apply(md, s)).toContain("**body**");
  });
});

describe("checklist criterion labels", () => {
  const md =
    ":::checklist\n" +
    "- [x] #C1 @human The login page reads well.\n" +
    "  evidence: checked by hand\n" +
    "- [ ] @human #C2 `bun test` exits 0.\n" +
    ":::\n";

  test("the label range excludes the marker, id and @human tokens", () => {
    const labels = render(md).querySelectorAll(".wp-check-label");
    expect(labels.length).toBe(2);
    const a = blkRange(labels[0])!;
    expect(md.slice(a.start, a.end)).toBe("The login page reads well.");
    // Token order is interchangeable and must not shift the label.
    const b = blkRange(labels[1])!;
    expect(md.slice(b.start, b.end)).toBe("`bun test` exits 0.");
  });

  test("editing a label leaves the checkbox, id and evidence line intact", () => {
    const label = render(md).querySelectorAll(".wp-check-label")[0];
    const range = blkRange(label)!;
    const s = spliceFromEdit(
      ownText(label),
      "The login page reads well at mobile widths.",
      md.slice(range.start, range.end),
      range.start,
    )!;
    expect(apply(md, s)).toBe(
      ":::checklist\n" +
        "- [x] #C1 @human The login page reads well at mobile widths.\n" +
        "  evidence: checked by hand\n" +
        "- [ ] @human #C2 `bun test` exits 0.\n" +
        ":::\n",
    );
  });
});

describe("nested structures", () => {
  test("a nested list item owns only its own text", () => {
    const md = "- outer item\n  - nested item\n- second\n";
    const items = render(md).querySelectorAll("li");
    const outer = items[0];
    expect(ownText(outer).trim()).toBe("outer item");
    const range = blkRange(outer)!;
    const s = spliceFromEdit(
      ownText(outer),
      "outer thing",
      md.slice(range.start, range.end),
      range.start,
    )!;
    expect(apply(md, s)).toBe("- outer thing\n  - nested item\n- second\n");
  });

  test("callout body paragraphs are editable, chrome is not", () => {
    const md = ":::assumption #A1 verified:code\nThe watcher is debounced.\n:::\n";
    const doc = render(md);
    const p = doc.querySelector(".wp-callout-entry p")!;
    const range = blkRange(p)!;
    expect(md.slice(range.start, range.end)).toBe("The watcher is debounced.");
    expect(doc.querySelector(".wp-callout-head")?.hasAttribute("data-blk")).toBe(
      false,
    );
  });

  test("table cells map to their column", () => {
    const md = "| Check | Owner |\n|---|---|\n| build | ci |\n";
    const cells = render(md).querySelectorAll("td");
    expect(cells.length).toBe(2);
    const range = blkRange(cells[1])!;
    expect(md.slice(range.start, range.end)).toBe("ci");
  });

  test("code fences and mermaid never become editable", () => {
    const md = "```ts src/x.ts\nconst a = 1;\n```\n\n```mermaid\nflowchart LR\n```\n";
    const doc = render(md);
    expect(doc.querySelector("figure.wp-code [data-blk]")).toBeNull();
    expect(doc.querySelector("figure.wp-mermaid [data-blk]")).toBeNull();
  });
});

describe("a real plan round-trips", () => {
  const path = join(
    import.meta.dir,
    "fixtures",
    "plans",
    "legible-per-phase-diagrams.md",
  );
  const md = readFileSync(path, "utf8");

  test("every stamped range slices out text its unit can be aligned to", () => {
    const doc = render(md);
    const units = [...doc.querySelectorAll("[data-blk]")];
    expect(units.length).toBeGreaterThan(50);

    const unmappable: string[] = [];
    for (const unit of units) {
      const range = blkRange(unit)!;
      const raw = md.slice(range.start, range.end);
      const text = ownText(unit);
      if (!text.trim()) continue;
      if (!alignTextToSource(text, raw)) unmappable.push(text.slice(0, 60));
    }
    expect(unmappable).toEqual([]);
  });

  test("every @human criterion label maps to its own source text", () => {
    const doc = render(md);
    const labels = [...doc.querySelectorAll(".wp-check-label")];
    expect(labels.length).toBeGreaterThan(10);
    for (const label of labels) {
      const range = blkRange(label)!;
      const raw = md.slice(range.start, range.end);
      expect(raw.startsWith("#")).toBe(false);
      expect(raw.includes("@human")).toBe(false);
      expect(raw.includes("\n")).toBe(false);
    }
  });
});
