import { describe, expect, test } from "bun:test";
import "./setup-dom";
import type { Comment } from "../src/shared/review";

const { renderMarkdown } = await import("../src/webview/lib/markdown");
const { injectCalloutUI, bindVerdicts, entryAnchor, handleCalloutClick } =
  await import("../src/webview/lib/calloutFeedback");
const { rangeFromOffsets } = await import("../src/webview/lib/anchor");

const MD = [
  "# Doc",
  "",
  "Intro paragraph.",
  "",
  ":::assumption\nFirst premise.\n:::",
  "",
  ":::assumption\nSecond premise.\n:::",
  "",
  ":::note\nNot reviewable.\n:::",
  "",
  ":::decision\nCheck it by hand.\n:::",
  "",
].join("\n");

function makeDoc(readOnly = false): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(MD);
  document.body.appendChild(el);
  injectCalloutUI(el, readOnly);
  return el as unknown as HTMLElement;
}

const verdictFor = (doc: HTMLElement, key: string, over: Partial<Comment> = {}): Comment => {
  const [type, ord] = key.split(":");
  const entry = doc.querySelector(
    `[data-callout="${type}"][data-callout-ord="${ord}"]`,
  ) as HTMLElement;
  const a = entryAnchor(doc, entry)!;
  return {
    id: `v-${key}`,
    quote: a.quote,
    start: a.start,
    end: a.end,
    body: "",
    createdAt: 1,
    kind: "verdict",
    verdict: "accept",
    callout: key,
    ...over,
  };
};

describe("injectCalloutUI", () => {
  test("adds badge + reject/comment actions to reviewable entries only, and no text", () => {
    const el = document.createElement("div");
    el.innerHTML = renderMarkdown(MD);
    const before = el.textContent;
    injectCalloutUI(el as unknown as HTMLElement, false);
    injectCalloutUI(el as unknown as HTMLElement, false); // idempotent
    expect(el.textContent).toBe(before);
    const reviewable = el.querySelectorAll("[data-callout]");
    expect(reviewable.length).toBe(3);
    for (const entry of reviewable) {
      expect(entry.querySelectorAll(".wp-callout-actions").length).toBe(1);
      // Reject + comment only — accept was retired; silence is assent.
      expect(entry.querySelectorAll(".wp-cal-btn").length).toBe(2);
      expect(entry.querySelector(".wp-cal-accept")).toBeNull();
      expect(entry.querySelectorAll(".wp-verdict").length).toBe(1);
    }
    const note = [...el.querySelectorAll(".wp-callout-entry")].find(
      (e) => !e.hasAttribute("data-callout"),
    )!;
    expect(note.querySelector(".wp-callout-actions")).toBeNull();
    expect(note.querySelector(".wp-verdict")).toBeNull();
  });

  test("read-only (sealed) documents get badges but no action buttons", () => {
    const doc = makeDoc(true);
    expect(doc.querySelectorAll(".wp-verdict").length).toBe(3);
    expect(doc.querySelectorAll(".wp-callout-actions").length).toBe(0);
  });
});

describe("entryAnchor", () => {
  test("offsets round-trip through rangeFromOffsets to the exact entry text", () => {
    const doc = makeDoc();
    for (const entry of doc.querySelectorAll("[data-callout]")) {
      const a = entryAnchor(doc, entry as HTMLElement)!;
      const range = rangeFromOffsets(doc, a.start, a.end)!;
      expect(range.toString()).toBe(a.quote);
      expect(a.quote).toContain(
        entry.getAttribute("data-callout") === "decision"
          ? "Check it by hand."
          : "premise.",
      );
    }
    const second = doc.querySelector('[data-callout-ord="2"]') as HTMLElement;
    expect(entryAnchor(doc, second)!.callout).toBe("assumption:2");
  });
});

describe("handleCalloutClick", () => {
  test("routes reject/comment clicks with the entry's anchor", () => {
    const doc = makeDoc();
    const calls: Array<{ kind: string; callout: string; verdict?: string }> = [];
    const cb = {
      onVerdict: (d: any) => calls.push({ kind: "verdict", callout: d.callout, verdict: d.verdict }),
      onComment: (a: any) => calls.push({ kind: "comment", callout: a.callout }),
    };
    const entry = doc.querySelector('[data-callout="decision"]')!;
    for (const cls of ["wp-cal-reject", "wp-cal-comment"]) {
      const btn = entry.querySelector(`.${cls} svg`) as HTMLElement; // click lands on the SVG
      const handled = handleCalloutClick({ target: btn } as unknown as MouseEvent, doc, cb);
      expect(handled).toBe(true);
    }
    expect(calls).toEqual([
      { kind: "verdict", callout: "decision:1", verdict: "reject" },
      { kind: "comment", callout: "decision:1" },
    ]);
    // A click elsewhere is not ours.
    const p = doc.querySelector("p")!;
    expect(handleCalloutClick({ target: p } as unknown as MouseEvent, doc, cb)).toBe(false);
  });
});

describe("bindVerdicts", () => {
  test("binds by key, renders badge classes, and toggles off when cleared", () => {
    const doc = makeDoc();
    const v = verdictFor(doc, "assumption:2");
    bindVerdicts(doc, [v]);
    const entry = doc.querySelector('[data-callout-ord="2"]')!;
    expect(entry.classList.contains("is-accepted")).toBe(true);
    expect(entry.querySelector(".wp-verdict")!.classList.contains("wp-verdict--accept")).toBe(true);
    // Accept has no button any more, but stored accepts still render.
    expect(entry.querySelector(".wp-verdict")!.getAttribute("title")).toBe("Accepted");
    // Other entries untouched.
    expect(doc.querySelectorAll(".is-accepted").length).toBe(1);

    bindVerdicts(doc, [{ ...v, verdict: "reject" }]);
    expect(entry.classList.contains("is-accepted")).toBe(false);
    expect(entry.classList.contains("is-rejected")).toBe(true);

    bindVerdicts(doc, []);
    expect(entry.classList.contains("is-rejected")).toBe(false);
    expect(entry.querySelector(".wp-verdict")!.classList.length).toBe(1);
  });

  test("drops the badge when the stored quote no longer matches the entry text", () => {
    const doc = makeDoc();
    const stale = verdictFor(doc, "assumption:1", {
      quote: "A different assumption entirely.",
    });
    bindVerdicts(doc, [stale]);
    const entry = doc.querySelector('[data-callout-ord="1"]')!;
    expect(entry.classList.contains("is-accepted")).toBe(false);
    expect(entry.querySelector(".wp-verdict")!.classList.contains("wp-verdict--accept")).toBe(false);
  });

  test("whitespace differences alone do not orphan a verdict", () => {
    const doc = makeDoc();
    const v = verdictFor(doc, "assumption:1");
    bindVerdicts(doc, [{ ...v, quote: `  ${v.quote.replace("\n", "  \n ")} ` }]);
    const entry = doc.querySelector('[data-callout-ord="1"]')!;
    expect(entry.classList.contains("is-accepted")).toBe(true);
  });
});

describe("ID-first anchoring", () => {
  const ID_MD = [
    ":::assumption #A1 verified:code\nFirst premise.\n:::",
    "",
    ":::assumption\nLegacy premise, no ID.\n:::",
    "",
  ].join("\n");

  function makeIdDoc(): HTMLElement {
    const el = document.createElement("div");
    el.innerHTML = renderMarkdown(ID_MD);
    document.body.appendChild(el);
    injectCalloutUI(el as unknown as HTMLElement, false);
    return el as unknown as HTMLElement;
  }

  test("entryAnchor prefers the ID key when data-callout-id is present", () => {
    const doc = makeIdDoc();
    const idd = doc.querySelector("[data-callout-id]") as HTMLElement;
    expect(entryAnchor(doc, idd)!.callout).toBe("assumption:A1");
    const legacy = doc.querySelector(
      "[data-callout]:not([data-callout-id])",
    ) as HTMLElement;
    expect(entryAnchor(doc, legacy)!.callout).toBe("assumption:2");
  });

  test("a new verdict on an ID'd entry stores the ID key", () => {
    const doc = makeIdDoc();
    const calls: any[] = [];
    const btn = doc.querySelector(
      "[data-callout-id] .wp-cal-reject svg",
    ) as HTMLElement;
    handleCalloutClick({ target: btn } as unknown as MouseEvent, doc, {
      onVerdict: (d) => calls.push(d),
      onComment: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].callout).toBe("assumption:A1");
    expect(calls[0].verdict).toBe("reject");
  });

  test("bindVerdicts falls back to the ordinal key for an entry that gained an ID", () => {
    const doc = makeIdDoc();
    const entry = doc.querySelector("[data-callout-id]") as HTMLElement;
    const a = entryAnchor(doc, entry)!;
    // Stored before the plan gained IDs → ordinal key, same text.
    const old: Comment = {
      id: "v-old",
      quote: a.quote,
      start: a.start,
      end: a.end,
      body: "",
      createdAt: 1,
      kind: "verdict",
      verdict: "accept",
      callout: "assumption:1",
    };
    bindVerdicts(doc, [old]);
    expect(entry.classList.contains("is-accepted")).toBe(true);
    // The quote gate still applies on the fallback path.
    bindVerdicts(doc, [{ ...old, quote: "A different entry entirely." }]);
    expect(entry.classList.contains("is-accepted")).toBe(false);
  });
});
