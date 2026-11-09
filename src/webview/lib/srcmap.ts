// Map an editable unit's rendered text back to the markdown that produced it.
//
// `renderMarkdown` stamps every editable unit (heading, paragraph, list item,
// table cell, checklist criterion label) with `data-blk="<start>:<end>"` — the
// unit's byte range in the plan source. This module turns a text edit inside
// such a unit into the smallest possible source splice, so writing back touches
// only the bytes the reviewer actually changed and every other parser of the
// file (phases.ts, drift.ts, tick.py) sees an otherwise untouched plan.
//
// The mapping is a greedy forward alignment. Rendered text is an in-order
// subsequence of its source for every inline construct the plan format uses
// (**bold**, `code`, [text](url), ~~strike~~, escapes, entities), so walking
// both strings forward and skipping unmatched source characters cannot
// mis-order. When the whole rendered text cannot be consumed the unit is simply
// not editable: this fails closed rather than guessing at a byte range.

export type Splice = {
  /** Absolute source offsets of the replaced span. */
  start: number;
  end: number;
  /** What the source currently holds at [start, end) — the host verifies it. */
  expected: string;
  /** Replacement text. */
  text: string;
  /** Where the change lands in the unit's rendered text, and its size delta. */
  textStart: number;
  removed: number;
  inserted: number;
};

const WS = /\s/;

/**
 * Per-character source indices for `text` within `raw`, or null when `raw`
 * does not contain `text` as an in-order subsequence.
 *
 * Whitespace matches whitespace rather than itself: marked collapses a newline
 * inside a code span to a space, so `` `f(a,\nb)` `` renders as `f(a, b)` and a
 * strict character match would give up on a paragraph that is merely
 * hard-wrapped. The match stays forward-only, so it still cannot mis-order.
 */
export function alignTextToSource(text: string, raw: string): number[] | null {
  const map = new Array<number>(text.length);
  let s = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const ws = WS.test(c);
    let at = -1;
    for (let j = s; j < raw.length; j++) {
      if (raw[j] === c || (ws && WS.test(raw[j]))) {
        at = j;
        break;
      }
    }
    if (at === -1) return null;
    map[i] = at;
    s = at + 1;
  }
  return map;
}

/** Deleted redline runs are chrome, not document text — never editable. */
export function isRedlineDeletion(el: Element): boolean {
  return el.tagName === "DEL" && el.classList.contains("wp-del");
}

// Tags whose surrounding whitespace is markup indentation, not prose. A
// whitespace-only text node next to one of these is the newline marked prints
// between tags; counting it would make a list item look like it owns the blank
// line before its nested list.
const BLOCK = new Set([
  "P", "UL", "OL", "LI", "DIV", "ASIDE", "FIGURE", "DETAILS", "TABLE",
  "THEAD", "TBODY", "TR", "TD", "TH", "PRE", "BLOCKQUOTE", "HR",
  "H1", "H2", "H3", "H4", "H5", "H6",
]);

const isLayoutWhitespace = (node: Node): boolean => {
  if ((node.textContent ?? "").trim() !== "") return false;
  const prev = (node as any).previousElementSibling as Element | null;
  const next = (node as any).nextElementSibling as Element | null;
  return (
    (prev != null && BLOCK.has(prev.tagName)) ||
    (next != null && BLOCK.has(next.tagName))
  );
};

/**
 * The text a unit owns: its own text nodes, minus anything claimed by a nested
 * editable unit (the inner `<li>` of a nested list), minus deleted redline
 * runs, minus inter-tag layout whitespace. Nested units are edited on their own
 * `data-blk` range, so excluding them here keeps each splice inside one unit's
 * source.
 */
export function ownText(unit: Element): string {
  let out = "";
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        if (!isLayoutWhitespace(child)) out += child.textContent ?? "";
      } else if (child.nodeType === 1) {
        const el = child as Element;
        if (el.hasAttribute("data-blk") || isRedlineDeletion(el)) continue;
        walk(el);
      }
    }
  };
  walk(unit);
  return out;
}

/** Parse a `data-blk="<start>:<end>"` attribute. */
export function blkRange(el: Element): { start: number; end: number } | null {
  const raw = el.getAttribute("data-blk");
  if (!raw) return null;
  const [a, b] = raw.split(":");
  const start = Number(a);
  const end = Number(b);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    return null;
  }
  return { start, end };
}

// A source span may not swallow anything that starts a new block: a blank line,
// a list marker, a heading, a table row, a `:::` container fence, or a code
// fence. Nor may it swallow the newline that terminates the unit. Deleting
// across a soft wrap inside a paragraph is fine and stays allowed — plan files
// are hard-wrapped, so that is an everyday edit.
const STRUCTURAL = /\n[ \t]*(?:$|\n|[-*+>|#]|\d+[.)]|:::|`{3}|~{3})/;

/**
 * True when inline delimiters in `span` are self-contained. A removal that
 * takes one half of a `**…**` or `` `…` `` pair would leave an orphan marker in
 * the file, so the caller declines that splice rather than corrupting the line.
 */
export function delimitersBalanced(span: string): boolean {
  // Count *runs*, not characters: `**bold` holds two asterisks but only one
  // opener, and losing that distinction is exactly the corruption this guards.
  // A backslash-escaped delimiter is literal text and does not count.
  const runsEven = (ch: string) =>
    (span.match(new RegExp(`(?<!\\\\)\\${ch}+`, "g")) ?? []).length % 2 === 0;
  if (!runsEven("`") || !runsEven("*") || !runsEven("_") || !runsEven("~")) {
    return false;
  }
  const count = (ch: string) => span.split(ch).length - 1;
  return count("[") === count("]") && count("(") === count(")");
}

/**
 * Derive the minimal source splice for a unit whose rendered text went from
 * `before` to `after`. `raw` is the unit's source, `base` its absolute offset.
 * Returns null when nothing changed or when the edit cannot be written back
 * safely — the caller then leaves the file alone.
 */
export function spliceFromEdit(
  before: string,
  after: string,
  raw: string,
  base: number,
): Splice | null {
  if (before === after || !before) return null;

  // Both sides are compared exactly as they stand. Normalizing one and not the
  // other would break the common prefix at the unit's first newline — and plan
  // prose is hard-wrapped, so that is every paragraph: a five-character
  // insertion would come out as a whole-paragraph replacement.
  let pre = 0;
  const min = Math.min(before.length, after.length);
  while (pre < min && before[pre] === after[pre]) pre++;
  let suf = 0;
  while (
    suf < min - pre &&
    before[before.length - 1 - suf] === after[after.length - 1 - suf]
  ) {
    suf++;
  }
  const beforeEnd = before.length - suf;
  // Newlines are stripped from the replacement only. One would break the
  // line-oriented grammar every other reader of the file relies on (`- [ ]`
  // criteria, `## Phase N` headings).
  const inserted = after.slice(pre, after.length - suf).replace(/[\r\n]+/g, " ");

  const map = alignTextToSource(before, raw);
  if (!map) return null;

  // Replacing a span that holds markup would write the rendered text over the
  // source — `**one**` coming back as `one`. Safe only when the removed
  // characters are contiguous in the source, i.e. nothing but text sits
  // between them. A pure deletion is exempt: markup inside it goes with it.
  if (inserted && beforeEnd > pre) {
    const width = map[beforeEnd - 1] - map[pre];
    if (width !== beforeEnd - 1 - pre) return null;
  }

  // A pure insertion (nothing removed) lands right after the preceding
  // character, so it never disturbs the markup around it.
  const start = pre < before.length ? map[pre] : map[before.length - 1] + 1;
  const end = beforeEnd > pre ? map[beforeEnd - 1] + 1 : start;
  const expected = raw.slice(start, end);

  if (STRUCTURAL.test(expected)) return null;
  if (!delimitersBalanced(expected)) return null;

  return {
    start: base + start,
    end: base + end,
    expected,
    text: inserted,
    textStart: pre,
    removed: beforeEnd - pre,
    inserted: inserted.length,
  };
}
