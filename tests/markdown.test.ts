import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./setup-dom";

// markdown.ts must be imported after the DOM globals exist — DOMPurify
// captures `window` at import time.
const { renderMarkdown, sanitizePlanHtml, REVIEWABLE_CALLOUTS } = await import(
  "../src/webview/lib/markdown"
);

function render(md: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(md);
  return el as unknown as HTMLElement;
}

const callout = (type: string, body: string) => `:::${type}\n${body}\n:::\n`;

describe("callout entries", () => {
  test("consecutive same-type callouts merge into one aside with per-entry wrappers", () => {
    const doc = render(
      callout("assumption", "First.") +
        "\n" +
        callout("assumption", "Second.") +
        "\n" +
        callout("assumption", "Third."),
    );
    const asides = doc.querySelectorAll("aside.wp-callout--assumption");
    expect(asides.length).toBe(1);
    const entries = asides[0].querySelectorAll(".wp-callout-entry");
    expect(entries.length).toBe(3);
    expect(asides[0].querySelectorAll("hr").length).toBe(0);
    expect([...entries].map((e) => e.textContent?.trim())).toEqual([
      "First.",
      "Second.",
      "Third.",
    ]);
  });

  test("reviewable entries carry data-callout + 1-based per-type ordinals in document order", () => {
    const doc = render(
      callout("assumption", "A1.") +
        "\n" +
        callout("assumption", "A2.") +
        "\n" +
        callout("decision", "D1.") +
        "\n" +
        callout("decision", "D2.") +
        "\n" +
        callout("assumption", "A3."),
    );
    const tagged = [...doc.querySelectorAll("[data-callout]")].map((e) => [
      e.getAttribute("data-callout"),
      e.getAttribute("data-callout-ord"),
    ]);
    expect(tagged).toEqual([
      ["assumption", "1"],
      ["assumption", "2"],
      ["decision", "1"],
      ["decision", "2"],
      ["assumption", "3"],
    ]);
  });

  test("note entries get wrappers but no data-callout", () => {
    const doc = render(callout("note", "Just a note."));
    const entry = doc.querySelector(".wp-callout .wp-callout-entry");
    expect(entry).not.toBeNull();
    expect(entry!.hasAttribute("data-callout")).toBe(false);
    expect(REVIEWABLE_CALLOUTS.has("note")).toBe(false);
  });

  test(":::validate no longer renders as a callout", () => {
    const doc = render(callout("validate", "Is the retry budget right?"));
    expect(doc.querySelector("aside.wp-callout--validate")).toBeNull();
    expect(REVIEWABLE_CALLOUTS.has("validate")).toBe(false);
  });
});

describe("callout tokens", () => {
  test("ID + status emits data-callout-id, wp-id badge, and a chip", () => {
    const doc = render(":::assumption #A3 verified:code\nBody.\n:::\n");
    const entry = doc.querySelector(".wp-callout-entry")!;
    expect(entry.getAttribute("data-callout-id")).toBe("A3");
    expect(entry.getAttribute("data-callout")).toBe("assumption");
    expect(entry.querySelector(".wp-id")?.getAttribute("data-id")).toBe("A3");
    // The first entry's chip rides the header row, beside the label.
    const head = doc.querySelector(".wp-callout-head")!;
    expect(
      head.querySelector(".wp-chip")?.classList.contains("wp-chip--verified-code"),
    ).toBe(true);
    expect(entry.querySelector(".wp-entry-meta")).toBeNull();
    // Default label — tokens are not a custom label.
    expect(doc.querySelector(".wp-callout-label")?.textContent).toBe(
      "Assumption",
    );
    // Badge and chip are text-free; labels are CSS generated content, so the
    // header row still reads as just its label.
    expect(head.textContent).toBe("Assumption");
  });

  // The skill text and this parser are one contract with no compiler between
  // them. When they drifted, every assumption in every plan rendered as a
  // green box headed "VERIFIED" with no chip, because an unrecognized word
  // ends the token scan and becomes the visible label. These two tests pin
  // both directions of that contract.
  test("every provenance token the skill teaches is a token, not a label", () => {
    const skill = readFileSync(
      join(import.meta.dir, "../.claude/skills/waypoint/SKILL.md"),
      "utf8",
    );
    const examples = [
      // The examples sit inside a fenced block nested in a list item, so they
      // carry leading indentation in the source.
      ...skill.matchAll(
        /^[ \t]*:::assumption[ \t]+(#[A-Za-z0-9]+[ \t]+\S+)[ \t]*$/gm,
      ),
    ].map((m) => m[1]);
    // Guard the guard: if the examples ever vanish, fail loudly rather than
    // vacuously passing over an empty list.
    expect(examples.length).toBeGreaterThan(0);
    for (const args of examples) {
      const doc = render(`:::assumption ${args}\nBody.\n:::\n`);
      expect(doc.querySelector(".wp-callout-label")?.textContent).toBe(
        "Assumption",
      );
      expect(doc.querySelector(".wp-callout-head .wp-chip")).not.toBeNull();
    }
  });

  test("a bare verified/unverified is not a token and falls through to the label", () => {
    for (const bad of ["verified", "unverified"]) {
      const doc = render(`:::assumption #A1 ${bad}\nBody.\n:::\n`);
      expect(doc.querySelector(".wp-callout-label")?.textContent).toBe(bad);
      expect(doc.querySelector(".wp-chip")).toBeNull();
    }
    // The `#` inside a probe reference is the same trap.
    const hashed = render(":::assumption #A1 verified:probe(#C1)\nBody.\n:::\n");
    expect(hashed.querySelector(".wp-callout-label")?.textContent).toBe(
      "verified:probe(#C1)",
    );
  });

  test("verified:probe(C2) carries data-ref on the chip", () => {
    const doc = render(":::assumption #A4 verified:probe(C2)\nBody.\n:::\n");
    const chip = doc.querySelector(".wp-chip")!;
    expect(chip.classList.contains("wp-chip--verified-probe")).toBe(true);
    expect(chip.getAttribute("data-ref")).toBe("C2");
  });

  test("plain args stay a custom label with no meta row", () => {
    const doc = render(":::assumption Read-path only\nBody.\n:::\n");
    expect(doc.querySelector(".wp-callout-label")?.textContent).toBe(
      "Read-path only",
    );
    expect(doc.querySelector(".wp-entry-meta")).toBeNull();
    expect(doc.querySelector(".wp-callout-entry")!.hasAttribute("data-callout-id")).toBe(false);
  });

  test("ID + status + trailing words → custom label after the tokens", () => {
    const doc = render(":::assumption #A5 asserted Latency budget\nBody.\n:::\n");
    expect(doc.querySelector(".wp-callout-label")?.textContent).toBe(
      "Latency budget",
    );
    expect(doc.querySelector(".wp-id")?.getAttribute("data-id")).toBe("A5");
    expect(
      doc.querySelector(".wp-chip")?.classList.contains("wp-chip--asserted"),
    ).toBe(true);
  });

  test("decision with ID only gets a badge and the base chip, no token chip", () => {
    const doc = render(":::decision #D1\nBody.\n:::\n");
    const entry = doc.querySelector(".wp-callout-entry")!;
    expect(entry.getAttribute("data-callout-id")).toBe("D1");
    expect(entry.querySelector(".wp-id")?.getAttribute("data-id")).toBe("D1");
    // Every decision states its kind; only entry 0's chips ride the header.
    expect(doc.querySelector(".wp-callout-head .wp-chip--proposed")).not.toBeNull();
    expect(doc.querySelector(".wp-chip:not(.wp-chip--proposed)")).toBeNull();
  });

  test("the base chip is text-free, so the header still reads as its label", () => {
    const doc = render(":::decision #D1\nBody.\n:::\n");
    expect(doc.querySelector(".wp-callout-head")?.textContent).toBe("Decision");
    // Assumptions carry provenance already and get no base chip of their own.
    const a = render(":::assumption #A1 asserted\nBody.\n:::\n");
    expect(a.querySelector(".wp-chip--proposed")).toBeNull();
  });

  test("status tokens are not recognized on decisions", () => {
    const doc = render(":::decision #D2 asserted\nBody.\n:::\n");
    expect(doc.querySelector(".wp-callout-label")?.textContent).toBe(
      "asserted",
    );
    expect(doc.querySelector(".wp-chip:not(.wp-chip--proposed)")).toBeNull();
  });

  test("malformed and duplicate tokens fall through into the label", () => {
    // `#1` is not letter-leading → the whole args is the label.
    const malformed = render(":::assumption #1 verified:code\nBody.\n:::\n");
    expect(malformed.querySelector(".wp-callout-label")?.textContent).toBe(
      "#1 verified:code",
    );
    expect(malformed.querySelector(".wp-entry-meta")).toBeNull();
    // A second ID token is a duplicate kind → starts the label.
    const dup = render(":::assumption #A1 #A2 rest\nBody.\n:::\n");
    expect(dup.querySelector(".wp-id")?.getAttribute("data-id")).toBe("A1");
    expect(dup.querySelector(".wp-callout-label")?.textContent).toBe("#A2 rest");
  });

  test("the ID badge trails the entry's last word, inside its final block", () => {
    const doc = render(":::assumption #A3 verified:code\nBody text.\n:::\n");
    const entry = doc.querySelector(".wp-callout-entry")!;
    const p = entry.querySelector("p")!;
    // Last element child of the paragraph → it follows the prose, not leads it.
    expect(p.lastElementChild?.classList.contains("wp-id")).toBe(true);
    expect(p.querySelector(".wp-id")?.getAttribute("data-id")).toBe("A3");
    // The rail is left to the feedback UI; the meta row holds chips only.
    expect(entry.querySelector(".wp-entry-rail")?.textContent).toBe("");
    expect(entry.querySelector(".wp-entry-rail .wp-id")).toBeNull();
    expect(entry.querySelector(".wp-entry-meta .wp-id")).toBeNull();
    // And it adds no document text, so comment offsets never move.
    expect(entry.textContent).toBe(render(":::assumption\nBody text.\n:::\n")
      .querySelector(".wp-callout-entry")!.textContent);
  });

  test("the ID badge lands inside the last list item, not after the list", () => {
    const doc = render(":::decision #D7\nWeighed:\n\n- one\n- two\n:::\n");
    const items = doc.querySelectorAll(".wp-callout-entry li");
    expect(items.length).toBe(2);
    expect(items[1].querySelector(".wp-id")?.getAttribute("data-id")).toBe("D7");
  });

  test("the ID badge stays outside an inline wrapper it would inherit", () => {
    const doc = render(":::assumption #A8\nIt ends in `code`\n:::\n");
    const p = doc.querySelector(".wp-callout-entry p")!;
    expect(p.querySelector("code .wp-id")).toBeNull();
    expect(p.lastElementChild?.classList.contains("wp-id")).toBe(true);
  });

  test("an entry ending in a fence keeps the ID as a trailing sibling", () => {
    const doc = render(":::decision #D9\nWhy:\n\n```js\nconst a = 1;\n```\n:::\n");
    const body = doc.querySelector(".wp-entry-body")!;
    expect(body.lastElementChild?.classList.contains("wp-id")).toBe(true);
    expect(body.querySelector("pre .wp-id")).toBeNull();
  });

  test("merged entries keep per-entry metas index-aligned", () => {
    const doc = render(
      ":::assumption #A1 verified:code\nFirst.\n:::\n\n:::assumption #A2 claim:external\nSecond.\n:::\n",
    );
    const entries = [...doc.querySelectorAll(".wp-callout-entry")];
    expect(entries.length).toBe(2);
    expect(entries[0].getAttribute("data-callout-id")).toBe("A1");
    // Entry 0's chip sits in the shared header; later entries keep their own
    // meta row above their prose.
    expect(
      doc.querySelector(".wp-callout-head .wp-chip--verified-code"),
    ).not.toBeNull();
    expect(entries[0].querySelector(".wp-entry-meta")).toBeNull();
    expect(entries[1].getAttribute("data-callout-id")).toBe("A2");
    expect(
      entries[1].querySelector(".wp-entry-meta .wp-chip--claim-external"),
    ).not.toBeNull();
  });
});

describe("file references", () => {
  test("path-shaped code spans carry path + line; others stay plain", () => {
    const doc = render(
      "See `src/extension/planStore.ts:42`, `.vscodeignore`, and `bun run build` — `.waypoint/plans/*.md` is a glob.\n",
    );
    const refs = [...doc.querySelectorAll("code.wp-ref")];
    expect(refs.map((r) => r.getAttribute("data-path"))).toEqual([
      "src/extension/planStore.ts",
      ".vscodeignore",
    ]);
    expect(refs[0].getAttribute("data-line")).toBe("42");
    expect(refs[1].hasAttribute("data-line")).toBe(false);
    // The glob and the command render as ordinary code.
    expect(doc.querySelectorAll("code").length).toBe(4);
  });

  test("the rendered text is untouched, so comment offsets cannot move", () => {
    const md = "Read `src/a.ts:42` then stop.\n";
    expect(render(md).textContent?.trim()).toBe("Read src/a.ts:42 then stop.");
  });

  test("attributes survive sanitization", () => {
    const el = document.createElement("div");
    el.innerHTML = sanitizePlanHtml(renderMarkdown("See `build.ts:7`.\n"));
    const ref = el.querySelector("code.wp-ref")!;
    expect(ref.getAttribute("data-path")).toBe("build.ts");
    expect(ref.getAttribute("data-line")).toBe("7");
  });
});

describe("fence-aware containers", () => {
  test("a fenced ::: inside a collapse does not close it early", () => {
    const doc = render(
      ":::collapse Drafts | examples\nBefore.\n```\n:::assumption #A9 asserted\nQuoted body.\n:::\n```\nAfter.\n:::\n",
    );
    const collapses = doc.querySelectorAll(".wp-collapse");
    expect(collapses.length).toBe(1);
    // The quoted callout stays fenced source, never a rendered callout.
    expect(doc.querySelector(".wp-callout--assumption")).toBeNull();
    expect(collapses[0].textContent).toContain(":::assumption #A9 asserted");
    expect(collapses[0].textContent).toContain("After.");
  });

  test("a four-backtick fence safely contains three-backtick lines", () => {
    const doc = render(
      ":::collapse Nested | fences\n````\n```\n:::\n```\n````\nTail.\n:::\n",
    );
    expect(doc.querySelectorAll(".wp-collapse").length).toBe(1);
    expect(doc.querySelector(".wp-collapse")!.textContent).toContain("Tail.");
  });
});

describe("round-2 decision tokens", () => {
  test("deviates + stakes emit chips on decisions", () => {
    const doc = render(
      ":::decision #D1 deviates:code stakes:irreversible\nBody.\n:::\n",
    );
    const entry = doc.querySelector(".wp-callout-entry")!;
    const head = doc.querySelector(".wp-callout-head")!;
    expect(entry.getAttribute("data-callout-id")).toBe("D1");
    expect(head.querySelector(".wp-chip--deviates-code")).not.toBeNull();
    expect(head.querySelector(".wp-chip--stakes-irreversible")).not.toBeNull();
    expect(doc.querySelector(".wp-callout-label")?.textContent).toBe("Decision");
    expect(head.textContent).toBe("Decision");
  });

  test("malformed deviates and stakes on assumptions fall through to the label", () => {
    const bad = render(":::decision deviates:nope\nBody.\n:::\n");
    expect(bad.querySelector(".wp-callout-label")?.textContent).toBe(
      "deviates:nope",
    );
    expect(bad.querySelector(".wp-chip:not(.wp-chip--proposed)")).toBeNull();
    const wrongType = render(":::assumption stakes:irreversible\nBody.\n:::\n");
    expect(wrongType.querySelector(".wp-callout-label")?.textContent).toBe(
      "stakes:irreversible",
    );
    expect(wrongType.querySelector(".wp-chip")).toBeNull();
  });

  test("revised(v<n>) chips carry data-rev on both callout types", () => {
    const a = render(":::assumption #A1 verified:code revised(v3)\nBody.\n:::\n");
    const chip = a.querySelector(".wp-chip--revised");
    expect(chip?.getAttribute("data-rev")).toBe("3");
    expect(a.querySelector(".wp-chip--verified-code")).not.toBeNull();
    const d = render(":::decision revised(v2)\nBody.\n:::\n");
    expect(d.querySelector(".wp-chip--revised")?.getAttribute("data-rev")).toBe("2");
    // Malformed version falls through into the label.
    const bad = render(":::decision revised(3)\nBody.\n:::\n");
    expect(bad.querySelector(".wp-chip--revised")).toBeNull();
    expect(bad.querySelector(".wp-callout-label")?.textContent).toBe("revised(3)");
  });
});

describe("evidence notes", () => {
  test("evidence: renders its note and marks the row evidenced", () => {
    const doc = render(
      ":::checklist\n- [x] #C1 `bun test` exits 0.\n  evidence: bun test exited 0.\n- [x] #C2 bare tick.\n:::\n",
    );
    const items = [...doc.querySelectorAll(".wp-check")];
    expect(items[0].classList.contains("wp-check--evidenced")).toBe(true);
    expect(
      items[0].querySelector(".wp-check-note--evidence")?.textContent,
    ).toBe("bun test exited 0.");
    expect(items[1].classList.contains("wp-check--evidenced")).toBe(false);
    expect(items[1].querySelector(".wp-check-note")).toBeNull();
  });

  test("override and evidence combine under one criterion", () => {
    const doc = render(
      ":::checklist\n- [x] #C1 e2e green.\n  override: flaky fixture.\n  evidence: run.log attached.\n:::\n",
    );
    const item = doc.querySelector(".wp-check")!;
    expect(item.querySelector(".wp-check-note--override")?.textContent).toBe(
      "flaky fixture.",
    );
    expect(item.querySelector(".wp-check-note--evidence")?.textContent).toBe(
      "run.log attached.",
    );
    expect(item.classList.contains("wp-check--evidenced")).toBe(true);
  });
});

describe("wrapped criteria", () => {
  test("a two-line criterion renders both lines in one label", () => {
    const doc = render(
      ":::checklist\n" +
        "- [ ] #C3 Open the login page at phone width; confirm no label\n" +
        "      truncates and the submit button stays visible.\n" +
        ":::\n",
    );
    const labels = doc.querySelectorAll(".wp-check-label");
    expect(labels.length).toBe(1);
    expect(labels[0].textContent).toBe(
      "Open the login page at phone width; confirm no label truncates and the submit button stays visible.",
    );
    // The ID is still stripped from the label and kept as metadata.
    expect(doc.querySelector(".wp-id")?.getAttribute("data-id")).toBe("C3");
  });

  test("the editable span covers the whole wrapped criterion", () => {
    const md =
      "# Plan\n\n:::checklist\n- [ ] #C1 first line of the criterion\n      and its second line.\n:::\n";
    const doc = render(md);
    const blk = doc.querySelector(".wp-check-label")!.getAttribute("data-blk")!;
    const [start, end] = blk.split(":").map(Number);
    expect(md.slice(start, end)).toBe(
      "first line of the criterion\n      and its second line.",
    );
  });

  test("a wrapped criterion still collects its evidence note", () => {
    const doc = render(
      ":::checklist\n" +
        "- [x] #C1 `bun test` exits 0 across the suite, including the new\n" +
        "      wrapped-criterion fixtures.\n" +
        "  evidence: bun test exited 0.\n" +
        ":::\n",
    );
    const item = doc.querySelector(".wp-check")!;
    expect(item.querySelector(".wp-check-label")?.textContent).toBe(
      "bun test exits 0 across the suite, including the new wrapped-criterion fixtures.",
    );
    expect(item.querySelector(".wp-check-note--evidence")?.textContent).toBe(
      "bun test exited 0.",
    );
    expect(item.classList.contains("wp-check--evidenced")).toBe(true);
  });

  test("single-line criteria are unchanged", () => {
    const doc = render(
      ":::checklist\n- [ ] #C1 plain.\n- [x] #C2 also plain.\n:::\n",
    );
    const items = [...doc.querySelectorAll(".wp-check")];
    expect(items.length).toBe(2);
    expect(items[0].querySelector(".wp-check-label")?.textContent).toBe("plain.");
    expect(items[1].classList.contains("is-checked")).toBe(true);
  });
});

describe("@human:blocking criteria", () => {
  test("blocking is marked, styled, and stripped from the label", () => {
    const doc = render(
      ":::checklist\n" +
        "- [ ] #C4 @human:blocking Open the migration report; confirm the row\n" +
        "      counts match.\n" +
        "- [ ] #C5 @human Plain human check.\n" +
        ":::\n",
    );
    const items = [...doc.querySelectorAll(".wp-check")];
    expect(items[0].classList.contains("wp-check--human")).toBe(true);
    expect(items[0].classList.contains("wp-check--blocking")).toBe(true);
    expect(items[0].querySelector(".wp-check-label")?.textContent).toBe(
      "Open the migration report; confirm the row counts match.",
    );
    expect(items[0].querySelector(".wp-check-human-badge")).not.toBeNull();
    // A plain `@human` criterion is human but not blocking.
    expect(items[1].classList.contains("wp-check--human")).toBe(true);
    expect(items[1].classList.contains("wp-check--blocking")).toBe(false);
  });

  test("data-raw keeps the joined source text, tokens included", () => {
    const doc = render(
      ":::checklist\n- [ ] #C4 @human:blocking Verify the report; confirm the\n      counts match.\n:::\n",
    );
    expect(doc.querySelector(".wp-check")?.getAttribute("data-raw")).toBe(
      "#C4 @human:blocking Verify the report; confirm the counts match.",
    );
  });
});

describe("runrecord callout", () => {
  test("renders its own non-reviewable type and merges", () => {
    const doc = render(
      callout("runrecord", "- deviation(D1): used X.") +
        "\n" +
        callout("runrecord", "- decided: split the phase."),
    );
    const asides = doc.querySelectorAll("aside.wp-callout--runrecord");
    expect(asides.length).toBe(1);
    expect(doc.querySelector(".wp-callout-label")?.textContent).toBe(
      "Run record",
    );
    expect(asides[0].querySelectorAll(".wp-callout-entry").length).toBe(2);
    expect(asides[0].querySelector("[data-callout]")).toBeNull();
    expect(REVIEWABLE_CALLOUTS.has("runrecord")).toBe(false);
  });
});

describe("boundary callout", () => {
  test(":::boundary renders its own callout type with no data-callout", () => {
    const doc = render(callout("boundary", "Consulted: src. Not reached: prod."));
    const aside = doc.querySelector("aside.wp-callout--boundary");
    expect(aside).not.toBeNull();
    expect(doc.querySelector(".wp-callout-label")?.textContent).toBe(
      "Context boundary",
    );
    expect(aside!.querySelector("[data-callout]")).toBeNull();
    expect(REVIEWABLE_CALLOUTS.has("boundary")).toBe(false);
  });

  test("consecutive boundary blocks merge into one aside", () => {
    const doc = render(
      callout("boundary", "First.") + "\n" + callout("boundary", "Second."),
    );
    const asides = doc.querySelectorAll("aside.wp-callout--boundary");
    expect(asides.length).toBe(1);
    expect(asides[0].querySelectorAll(".wp-callout-entry").length).toBe(2);
  });
});

describe("@human criteria", () => {
  const CHECKLIST =
    ":::checklist\n- [ ] `bun test` passes.\n- [ ] @human The layout looks right.\n- [x] @human Sign-off given.\n:::\n";

  test("renders orange class + Human badge and strips the @human marker", () => {
    const doc = render(CHECKLIST);
    const items = [...doc.querySelectorAll(".wp-check")];
    expect(items.length).toBe(3);
    expect(items[0].classList.contains("wp-check--human")).toBe(false);
    expect(items[0].querySelector(".wp-check-human-badge")).toBeNull();
    const human = items[1];
    expect(human.classList.contains("wp-check--human")).toBe(true);
    expect(human.querySelector(".wp-check-human-badge")?.textContent).toBe("Human");
    expect(human.querySelector(".wp-check-label")?.textContent).toBe(
      "The layout looks right.",
    );
    expect(items[2].classList.contains("is-checked")).toBe(true);
  });

  test("data-raw keeps the source text (marker included) for write-through", () => {
    const doc = render(CHECKLIST);
    const raws = [...doc.querySelectorAll(".wp-check")].map((e) =>
      e.getAttribute("data-raw"),
    );
    expect(raws).toEqual([
      "`bun test` passes.",
      "@human The layout looks right.",
      "@human Sign-off given.",
    ]);
  });
});

describe("criterion IDs", () => {
  test("#ID is stripped from the label, kept in data-raw, rendered as wp-id", () => {
    const doc = render(":::checklist\n- [ ] #C1 `bun test` exits 0.\n:::\n");
    const item = doc.querySelector(".wp-check")!;
    expect(item.getAttribute("data-raw")).toBe("#C1 `bun test` exits 0.");
    expect(item.querySelector(".wp-id")?.getAttribute("data-id")).toBe("C1");
    expect(item.querySelector(".wp-check-label")?.textContent).toBe(
      "bun test exits 0.",
    );
  });

  test("#ID and @human combine in either order", () => {
    const doc = render(
      ":::checklist\n- [ ] #C2 @human Chips legible.\n- [ ] @human #C3 Layout holds.\n:::\n",
    );
    const items = [...doc.querySelectorAll(".wp-check")];
    for (const [i, [id, label]] of [
      ["C2", "Chips legible."],
      ["C3", "Layout holds."],
    ].entries()) {
      expect(items[i].classList.contains("wp-check--human")).toBe(true);
      expect(items[i].querySelector(".wp-id")?.getAttribute("data-id")).toBe(id);
      expect(items[i].querySelector(".wp-check-label")?.textContent).toBe(label);
    }
  });
});

describe("override notes", () => {
  test("indented override: renders under its criterion; stray lines stay dropped", () => {
    const doc = render(
      ":::checklist\n- [x] #C3 e2e suite green.\n  override: flaky upstream fixture; green locally 3x.\n  some stray line\n- [ ] #C4 Next.\n:::\n",
    );
    const items = [...doc.querySelectorAll(".wp-check")];
    expect(items.length).toBe(2);
    const note = items[0].querySelector(".wp-check-note--override");
    expect(note?.textContent).toBe("flaky upstream fixture; green locally 3x.");
    expect(items[0].querySelector(".wp-check-main")).not.toBeNull();
    expect(doc.textContent).not.toContain("some stray line");
    // The plain criterion gets no wrapper and no note.
    expect(items[1].querySelector(".wp-check-main")).toBeNull();
    expect(items[1].querySelector(".wp-check-note")).toBeNull();
  });
});

describe("sanitization", () => {
  test("DOMPurify is active and keeps the data attributes", () => {
    const doc = render(
      `<script>alert(1)</script>\n\n<p onclick="x()">hi</p>\n\n` +
        callout("assumption", "Kept."),
    );
    expect(doc.querySelectorAll("script").length).toBe(0);
    expect(doc.querySelector("[onclick]")).toBeNull();
    const entry = doc.querySelector("[data-callout='assumption']");
    expect(entry).not.toBeNull();
    expect(entry!.getAttribute("data-callout-ord")).toBe("1");
  });

  test("keeps data-rev on revised chips", () => {
    const doc = render(":::assumption revised(v4)\nKept.\n:::\n");
    expect(
      doc.querySelector(".wp-chip--revised")?.getAttribute("data-rev"),
    ).toBe("4");
  });

  test("keeps data-callout-id, data-id, and data-ref", () => {
    const doc = render(
      ":::assumption #A1 verified:probe(C2)\nKept.\n:::\n\n:::checklist\n- [ ] #C2 probe.\n:::\n",
    );
    const entry = doc.querySelector(".wp-callout-entry")!;
    expect(entry.getAttribute("data-callout-id")).toBe("A1");
    expect(doc.querySelector(".wp-chip")?.getAttribute("data-ref")).toBe("C2");
    expect(
      doc.querySelector(".wp-check .wp-id")?.getAttribute("data-id"),
    ).toBe("C2");
  });
});

describe("rendered text identity", () => {
  test("entry wrappers add no text vs the pre-change snapshot", async () => {
    const md = await Bun.file(join(import.meta.dir, "fixtures/identity.md")).text();
    const snapshot = await Bun.file(
      join(import.meta.dir, "fixtures/identity.textcontent.txt"),
    ).text();
    expect(render(md).textContent).toBe(snapshot);
  });
});
