// Map a DOM Selection to character offsets in the container's rendered text,
// and reconstruct a Range from those offsets (for re-highlighting after reload).
//
// One definition of "the document's text" serves the whole viewer: every text
// node except those inside a deleted redline run. A <del> records what the plan
// used to say, not what it says — counting it would shift every stored comment
// offset the moment a reviewer edits above one, and would feed deleted words
// into the source alignment in lib/srcmap.ts.

import { isRedlineDeletion } from "./srcmap";

export type SelectionAnchor = { start: number; end: number; quote: string };

/** Text nodes of `root` in document order, skipping deleted redline runs. */
export function textWalker(root: Node): TreeWalker {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      for (
        let el = node.parentElement;
        el && el !== root;
        el = el.parentElement
      ) {
        if (isRedlineDeletion(el)) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
}

/** The text `range` covers, skipping deleted redline runs. */
function textIn(root: Node, range: Range): string {
  const walker = textWalker(root);
  let out = "";
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0;
    if (!len) continue;
    if (range.comparePoint(node, len) < 0) continue; // wholly before the range
    if (range.comparePoint(node, 0) > 0) break; // wholly after it
    // A text node that only partly overlaps must be the range's own start or
    // end container, so these two offsets cover every case.
    const from = range.startContainer === node ? range.startOffset : 0;
    const to = range.endContainer === node ? range.endOffset : len;
    out += (node.textContent ?? "").slice(from, to);
  }
  return out;
}

export function offsetsFromSelection(root: HTMLElement): SelectionAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const pre = document.createRange();
  pre.setStart(root, 0);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = textIn(root, pre).length;
  const quote = textIn(root, range);
  if (!quote.trim()) return null;

  return { start, end: start + quote.length, quote };
}

export function rangeFromOffsets(
  root: Node,
  start: number,
  end: number,
): Range | null {
  const walker = textWalker(root);
  const range = document.createRange();
  let pos = 0;
  let started = false;
  let node: Node | null;

  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0;
    if (!started && pos + len >= start) {
      range.setStart(node, Math.max(0, start - pos));
      started = true;
    }
    if (started && pos + len >= end) {
      range.setEnd(node, Math.max(0, end - pos));
      return range;
    }
    pos += len;
  }
  return started ? range : null;
}
