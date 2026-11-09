// Keeping the reader's place across a view swap.
//
// The plan view and the redline view are separate components with separate
// scroll containers, so toggling between them mounts a fresh one at the top.
// A pixel offset cannot carry over — the redline is longer, since deleted text
// stays on the page — and the runtime heading ids cannot either, being
// index-based and differently prefixed per component.
//
// Heading text is the one thing both renderings share, so that is the anchor.

export type ReadingAnchor = { text: string; offset: number };

const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const headingsIn = (docEl: HTMLElement) =>
  [...docEl.querySelectorAll("h1, h2")] as HTMLElement[];

/**
 * The last heading at or above the top of the viewport, and how far above it
 * sits. Returns null before the document has rendered, or when the reader is
 * above the first heading — in which case the top is already the right place.
 */
export function readingAnchor(
  mainEl?: HTMLElement,
  docEl?: HTMLElement,
): ReadingAnchor | null {
  if (!mainEl || !docEl) return null;
  const mt = mainEl.getBoundingClientRect().top;
  let best: ReadingAnchor | null = null;
  for (const h of headingsIn(docEl)) {
    const offset = h.getBoundingClientRect().top - mt;
    // Headings are in document order, so the first one below the fold means
    // every remaining one is too.
    if (offset > 12) break;
    best = { text: norm(h.textContent), offset };
  }
  return best;
}

/** Put `anchor`'s heading back where it was. Returns false if it is gone. */
export function restoreReading(
  anchor: ReadingAnchor | null,
  mainEl?: HTMLElement,
  docEl?: HTMLElement,
): boolean {
  if (!anchor || !mainEl || !docEl) return false;
  const hs = headingsIn(docEl);
  let hit = hs.find((h) => norm(h.textContent) === anchor.text);
  // A heading whose own words changed reads differently in the redline, where
  // the old and new wording sit side by side. Match on the opening words then.
  if (!hit && anchor.text.length > 8) {
    const head = anchor.text.slice(0, 24);
    hit = hs.find((h) => norm(h.textContent).startsWith(head));
  }
  if (!hit) return false;
  const mt = mainEl.getBoundingClientRect().top;
  mainEl.scrollTop += hit.getBoundingClientRect().top - mt - anchor.offset;
  return true;
}
