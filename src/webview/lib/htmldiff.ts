// Word-level HTML diff. Given two HTML strings (the *rendered* markdown of two
// plan versions), produce merged HTML where inserted word runs are wrapped in
// <ins class="wp-ins"> and deleted runs in <del class="wp-del">. Tags are never
// wrapped, so block structure (headings, <aside> callouts, <figure> code,
// checklist <li>) stays valid and the redlines land on the changed text.
//
// The match is a classic difflib-style longest-common-subsequence over tokens,
// from shared/difflib — the same matcher the host uses to turn the reviewer's
// inline edits into review-file entries.

import { opcodes } from "../../shared/difflib";

type Token = { tag: boolean; text: string };

/** Split HTML into tag tokens (`<…>`) and word/whitespace tokens. */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    if (html[i] === "<") {
      let j = html.indexOf(">", i);
      if (j === -1) j = n - 1;
      tokens.push({ tag: true, text: html.slice(i, j + 1) });
      i = j + 1;
    } else {
      let j = i;
      while (j < n && html[j] !== "<") j++;
      // Each token is a maximal run of whitespace OR non-whitespace, so spacing
      // is preserved on re-join and only changed words get wrapped.
      const parts = html.slice(i, j).match(/\S+\s*|\s+/g);
      if (parts) for (const p of parts) tokens.push({ tag: false, text: p });
      i = j;
    }
  }
  return tokens;
}

const tagName = (text: string) =>
  /^<\/?([a-zA-Z][\w-]*)/.exec(text)?.[1].toLowerCase() ?? "";

const isClose = (text: string) => text[1] === "/";

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "source", "track", "wbr",
]);

/**
 * Tags compare by name, not by their full text. A checkbox tick turns
 * `class="wp-check"` into `class="wp-check is-checked"` and an inline edit
 * shifts every `data-blk` after it; keyed on the whole tag those read as
 * wholesale replacements and the diff churns structure that never changed.
 */
const key = (t: Token) =>
  t.tag
    ? "T:" + (isClose(t.text) ? "/" : "") + tagName(t.text)
    : "W:" + t.text.replace(/\s+$/, " ");

/**
 * Which tag tokens in a deleted run may be written through. A tag whose partner
 * survived on the new side would land in the output unmatched — a `<li>` open
 * with no close — so only tags that open *and* close inside the deleted run are
 * kept. A wholly deleted paragraph therefore keeps its `<p>`, while a list item
 * that merely lost its text does not smuggle a stray `<li>` into the document.
 */
function balancedTags(tokens: Token[]): boolean[] {
  const keep = tokens.map((t) => t.tag && VOID.has(tagName(t.text)));
  const open: number[] = [];
  tokens.forEach((t, i) => {
    if (!t.tag || keep[i]) return;
    if (t.text.endsWith("/>")) {
      keep[i] = true;
    } else if (isClose(t.text)) {
      const at = open.pop();
      if (at != null && tagName(tokens[at].text) === tagName(t.text)) {
        keep[at] = true;
        keep[i] = true;
      }
    } else {
      open.push(i);
    }
  });
  return keep;
}

/**
 * Emit a run of tokens, wrapping contiguous word runs in <ins>/<del> while
 * leaving tag tokens bare — so a redline span never crosses (or nests inside) a
 * tag. Pure-whitespace buffers are emitted unwrapped to keep the markup clean.
 *
 * Inserted runs are new-side markup and pass through whole. Deleted runs are
 * filtered by `balancedTags`, so the merged HTML stays well-formed: a deleted
 * element that is whole keeps its wrapper, and a half-deleted one contributes
 * words only.
 */
function emitWrapped(tokens: Token[], kind: "ins" | "del"): string {
  const cls = kind === "ins" ? "wp-ins" : "wp-del";
  // Deleted text is a record of what the plan used to say, not document text:
  // it is inert to the caret and skipped by every text walk in the viewer.
  const attrs =
    kind === "del" ? ` class="${cls}" contenteditable="false"` : ` class="${cls}"`;
  const keep = kind === "del" ? balancedTags(tokens) : null;
  let out = "";
  let buf = "";
  const flush = () => {
    if (!buf) return;
    if (buf.trim() === "") out += buf;
    else out += `<${kind}${attrs}>${buf}</${kind}>`;
    buf = "";
  };
  tokens.forEach((t, i) => {
    if (t.tag) {
      flush();
      // A wrapper written through from the old side carries that side's
      // `data-blk` — byte offsets into the baseline, not the live plan. Strip
      // it so the invariant holds: every source range in the document addresses
      // the file as it is now.
      if (!keep) out += t.text;
      else if (keep[i]) out += t.text.replace(/\s+data-blk="[^"]*"/g, "");
    } else {
      buf += t.text;
    }
  });
  flush();
  return out;
}

/** Merge oldHtml → newHtml into a single redlined HTML string. */
export function htmldiff(oldHtml: string, newHtml: string): string {
  const a = tokenize(oldHtml);
  const b = tokenize(newHtml);
  const aKeys = a.map(key);
  const bKeys = b.map(key);

  let out = "";
  for (const [op, i1, i2, j1, j2] of opcodes(aKeys, bKeys)) {
    if (op === "equal") {
      for (let x = j1; x < j2; x++) out += b[x].text;
    } else if (op === "delete") {
      out += emitWrapped(a.slice(i1, i2), "del");
    } else if (op === "insert") {
      out += emitWrapped(b.slice(j1, j2), "ins");
    } else {
      // replace: old text first, then new, so they sit adjacent in place.
      out += emitWrapped(a.slice(i1, i2), "del");
      out += emitWrapped(b.slice(j1, j2), "ins");
    }
  }
  return out;
}
