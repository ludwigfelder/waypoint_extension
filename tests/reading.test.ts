import { describe, expect, test } from "bun:test";
import "./setup-dom";

const { readingAnchor, restoreReading } = await import("../src/webview/lib/reading");

/**
 * jsdom reports every rect as zero, so the geometry is stubbed: each heading is
 * placed at a known offset and the container tracks its own scrollTop. That is
 * enough to pin the arithmetic and the matching, which is where the bugs live.
 */
function view(headings: { text: string; top: number }[], scrollTop = 0) {
  const main = document.createElement("div");
  const doc = document.createElement("div");
  main.appendChild(doc);
  (main as any).scrollTop = scrollTop;
  main.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  for (const h of headings) {
    const el = document.createElement("h2");
    el.textContent = h.text;
    // Rect top is viewport-relative, so it moves as the container scrolls.
    el.getBoundingClientRect = () =>
      ({ top: h.top - (main as any).scrollTop }) as DOMRect;
    doc.appendChild(el);
  }
  return { main, doc };
}

const SECTIONS = [
  { text: "Context", top: 0 },
  { text: "Phase 1: Parser", top: 500 },
  { text: "Phase 2: Callouts", top: 1200 },
];

describe("readingAnchor", () => {
  test("names the last heading at or above the fold, with its offset", () => {
    const { main, doc } = view(SECTIONS, 1250);
    expect(readingAnchor(main, doc)).toEqual({
      text: "phase 2: callouts",
      offset: -50,
    });
  });

  test("is null above the first heading — the top is already the right place", () => {
    const { main, doc } = view([{ text: "Context", top: 40 }], 0);
    expect(readingAnchor(main, doc)).toBeNull();
  });

  test("is null before either element exists", () => {
    expect(readingAnchor(undefined, undefined)).toBeNull();
  });
});

describe("restoreReading", () => {
  test("puts the heading back at the same offset in a longer document", () => {
    // The redline is taller: deleted text stays on the page, so the same
    // heading sits 300px further down.
    const { main, doc } = view(
      [
        { text: "Context", top: 0 },
        { text: "Phase 1: Parser", top: 800 },
        { text: "Phase 2: Callouts", top: 1500 },
      ],
      0,
    );
    expect(restoreReading({ text: "phase 2: callouts", offset: -50 }, main, doc)).toBe(true);
    expect(main.scrollTop).toBe(1550);
  });

  test("falls back to the opening words when a heading's own text changed", () => {
    // In the redline a retitled heading carries both wordings at once.
    const { main, doc } = view(
      [{ text: "Phase 9: A first-run guideThe header controls", top: 600 }],
      0,
    );
    expect(
      restoreReading({ text: "phase 9: a first-run guide", offset: 0 }, main, doc),
    ).toBe(true);
    expect(main.scrollTop).toBe(600);
  });

  test("reports failure rather than jumping when the heading is gone", () => {
    const { main, doc } = view(SECTIONS, 400);
    expect(restoreReading({ text: "phase 7: deleted", offset: 0 }, main, doc)).toBe(false);
    expect(main.scrollTop).toBe(400);
  });

  test("a null anchor is a no-op", () => {
    const { main, doc } = view(SECTIONS, 400);
    expect(restoreReading(null, main, doc)).toBe(false);
    expect(main.scrollTop).toBe(400);
  });
});
