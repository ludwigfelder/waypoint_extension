import { marked, Renderer, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { makeFenceTracker } from "./fences";
import { parseFileRef } from "../../shared/refs";
import { scanChecklist } from "../../shared/checklist";

/* ------------------------------------------------------------------ *
 * Waypoint Plan Markdown — standard markdown plus:
 *   ```lang filename                   code block with a filename tab
 *   :::note … :::                      callout box
 *   :::assumption … :::                 labeled callout (also :::decision)
 *   :::boundary … :::                   context-boundary disclosure
 *   :::collapse Title | Subtitle … :::  collapsible section (header + subtitle)
 *   :::checklist Title                  checklist card
 *   - [ ] / - [x] items
 *   :::
 *
 * Callout opening lines and checklist criteria share one left-scan token
 * grammar: recognized tokens (`#<id>`, assumption status tokens, `@human`)
 * are consumed from the left; the first unrecognized word starts the visible
 * label, verbatim — malformed tokens fall through visibly, never silently.
 *
 * Underlines are reserved exclusively for comments (drawn via the CSS Custom
 * Highlight API), so there is no inline author-highlight syntax.
 * ------------------------------------------------------------------ */

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

const CARET =
  '<svg class="wp-caret" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7.5L10 12.5L15 7.5"/></svg>';
const CHECK =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l3.5 3.5L16 5.5"/></svg>';
const PLUS =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"/></svg>';

/** Callout container types → default label ("" = no label header). */
const CALLOUT_LABELS: Record<string, string> = {
  note: "",
  assumption: "Assumption",
  decision: "Decision",
  warning: "Warning",
  info: "Note",
  boundary: "Context boundary",
  runrecord: "Run record",
};

export const ID_PATTERN = "[A-Za-z][A-Za-z0-9._-]*";

export interface CalloutMeta {
  id?: string;
  status?: string;
  statusRef?: string;
  deviates?: string;
  stakes?: string;
  revisedV?: string;
  label: string;
}

/**
 * Left-scan the callout opening line's args: consume recognized tokens from
 * the left (each kind at most once), stop at the first unrecognized word —
 * everything after is the label, verbatim. IDs (`#A1`) are recognized on
 * assumption/decision; status tokens only on assumption. Duplicate or
 * malformed tokens fall through into the visible label.
 */
export function parseCalloutArgs(name: string, args: string): CalloutMeta {
  const idOk = name === "assumption" || name === "decision";
  const statusOk = name === "assumption";
  const decisionOk = name === "decision";
  if (!idOk) return { label: args };
  const meta: CalloutMeta = { label: "" };
  let rest = args;
  while (rest) {
    const m = /^(\S+)(?:[ \t]+|$)/.exec(rest);
    if (!m) break;
    const word = m[1];
    let t: RegExpExecArray | null;
    if (
      meta.id == null &&
      (t = new RegExp(`^#(${ID_PATTERN})$`).exec(word))
    ) {
      meta.id = t[1];
    } else if (
      statusOk &&
      meta.status == null &&
      /^(verified:code|claim:external|asserted)$/.test(word)
    ) {
      meta.status = word;
    } else if (
      statusOk &&
      meta.status == null &&
      (t = new RegExp(`^verified:probe(?:\\((${ID_PATTERN})\\))?$`).exec(word))
    ) {
      meta.status = "verified:probe";
      if (t[1]) meta.statusRef = t[1];
    } else if (
      decisionOk &&
      meta.deviates == null &&
      (t = /^deviates:(spec|code|convention)$/.exec(word))
    ) {
      meta.deviates = t[1];
    } else if (
      decisionOk &&
      meta.stakes == null &&
      (t = /^stakes:(irreversible|security-boundary|public-api)$/.exec(word))
    ) {
      meta.stakes = t[1];
    } else if (
      meta.revisedV == null &&
      (t = /^revised\(v(\d+)\)$/.exec(word))
    ) {
      meta.revisedV = t[1];
    } else {
      break;
    }
    rest = rest.slice(m[0].length);
  }
  meta.label = rest;
  return meta;
}

/**
 * Callout types reviewers can react to (accept / reject / comment). Their
 * entries carry `data-callout` + `data-callout-ord` so the viewer can address
 * each entry; other callout types render plain entries. Human validation is
 * not a callout — it is the `@human` checklist-item subtype below.
 */
export const REVIEWABLE_CALLOUTS = new Set(["assumption", "decision"]);

// Tags the ID badge may be tucked inside (they hold inline content) and the
// inline wrappers it must be tucked *outside* of — landing inside a `<code>`
// or an `<em>` would inherit their styling.
const INLINE_HOST = new Set([
  "p", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "td", "th", "dd", "dt", "figcaption", "blockquote", "div",
]);
const INLINE_WRAPPER = new Set([
  "code", "em", "strong", "a", "span", "del", "ins", "kbd", "sub", "sup",
  "abbr", "mark", "small", "s", "u", "b", "i", "strike",
]);

/**
 * An entry's provenance / stakes / revision chips, as text-free spans whose
 * labels are CSS generated content — so adding, upgrading, or hoisting one
 * never moves a document character offset.
 */
function chipsHtml(meta: CalloutMeta | undefined, name?: string): string {
  // A decision's kind is carried by no token: `deviates:` and `stakes:` are
  // optional extras, so a plain decision would show its label and nothing else.
  // An assumption always states its provenance and needs no such base chip.
  const base =
    name === "decision" ? `<span class="wp-chip wp-chip--proposed"></span>` : "";
  if (!meta) return base;
  return (
    base +
    (meta.status
      ? `<span class="wp-chip wp-chip--${meta.status.replace(":", "-")}"` +
        (meta.statusRef ? ` data-ref="${escAttr(meta.statusRef)}"` : "") +
        `></span>`
      : "") +
    (meta.deviates
      ? `<span class="wp-chip wp-chip--deviates-${meta.deviates}"></span>`
      : "") +
    (meta.stakes
      ? `<span class="wp-chip wp-chip--stakes-${meta.stakes}"></span>`
      : "") +
    (meta.revisedV
      ? `<span class="wp-chip wp-chip--revised" data-rev="${escAttr(meta.revisedV)}"></span>`
      : "")
  );
}

/**
 * Append a text-free marker to the end of a rendered block's *content*, so it
 * trails the final word rather than claiming a line of its own.
 *
 * Works on the trailing run of closing tags: walk it outward from the text,
 * stepping over inline wrappers, and insert just inside the first element that
 * can host inline content. When the block cannot host one (a fenced code block,
 * a table wrapper) the marker is appended after it instead — CSS floats it to
 * the trailing edge there. The marker carries no text, so document character
 * offsets — and every comment anchored to them — are untouched.
 */
export function withTrailingMarker(html: string, marker: string): string {
  const run = /(?:\s*<\/[a-zA-Z][a-zA-Z0-9]*\s*>)+\s*$/.exec(html);
  if (run) {
    const tag = /\s*<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/gy;
    tag.lastIndex = run.index;
    for (let m = tag.exec(html); m; m = tag.exec(html)) {
      const name = m[1].toLowerCase();
      if (INLINE_HOST.has(name)) {
        return html.slice(0, m.index) + marker + html.slice(m.index);
      }
      if (!INLINE_WRAPPER.has(name)) break;
    }
  }
  return html + marker;
}

/** :::name args … ::: (collapse | note | assumption | decision | checklist) */
const container = {
  name: "container",
  level: "block" as const,
  start(src: string) {
    const m = src.match(/^:::/m);
    return m ? m.index : undefined;
  },
  tokenizer(this: any, src: string) {
    const open = /^:::([a-zA-Z]+)[ \t]*([^\n]*)\n/.exec(src);
    if (!open) return;
    const [, rawName, args] = open;
    // Walk the body line by line with a fence tracker: the closing `:::` must
    // sit outside any ``` / ~~~ fence, so fenced examples that quote plan
    // syntax never terminate the container early.
    const lines = src.slice(open[0].length).split("\n");
    const fenced = makeFenceTracker();
    let close = -1;
    for (let i = 0; i < lines.length; i++) {
      if (fenced(lines[i])) continue;
      if (/^:::[ \t]*$/.test(lines[i])) {
        close = i;
        break;
      }
    }
    if (close === -1) return;
    const body = lines.slice(0, close).join("\n");
    // Consumed = opening line + body + closing line (+ its newline if any),
    // then any following blank lines (the old regex's `(?:\n+|$)`).
    let consumed = open[0].length;
    for (let i = 0; i <= close; i++) consumed += lines[i].length + 1;
    if (consumed > src.length) consumed = src.length;
    while (consumed < src.length && src[consumed] === "\n") consumed++;
    const raw = src.slice(0, consumed);
    const name = rawName.toLowerCase();
    const token: any = {
      type: "container",
      raw,
      name,
      args: args.trim(),
      tokens: [],
      items: [] as any[],
      // Where `body` starts inside `raw` — the source-offset pass below turns
      // the body-relative positions recorded here into absolute file offsets.
      bodyOff: open[0].length,
      body,
    };
    if (name in CALLOUT_LABELS) token.meta = parseCalloutArgs(name, token.args);
    if (name === "checklist") {
      // Where each body line starts, so a criterion's span — which may wrap
      // across lines — maps back to a source range for inline editing.
      const lineOff: number[] = [];
      let off = 0;
      for (const line of body.split("\n")) {
        lineOff.push(off);
        off += line.length + 1;
      }
      for (const c of scanChecklist(body)) {
        // Leading tokens — `#<id>` and `@human` / `@human:blocking` (each at
        // most once, either order) — are stripped from the rendered label;
        // `raw` keeps the source text (tokens included) so the viewer can
        // address the exact criterion. `@human` marks a criterion only the
        // reviewer may tick; `:blocking` additionally halts the run.
        let rest = c.raw;
        let human = false;
        let blocking = false;
        let id: string | undefined;
        for (;;) {
          let t: RegExpExecArray | null;
          if (!human && (t = /^@human(:blocking)?\s+/.exec(rest))) {
            human = true;
            blocking = t[1] != null;
          } else if (
            id == null &&
            (t = new RegExp(`^#(${ID_PATTERN})\\s+`).exec(rest))
          ) {
            id = t[1];
          } else {
            break;
          }
          rest = rest.slice(t[0].length);
        }
        // The editable region is the label only: the `- [x] #C1 @human `
        // prefix stays out of reach so a reviewer's typing can never break the
        // criterion grammar or retire an ID. It runs to the end of the last
        // wrapped line, so editing a wrapped criterion splices the whole
        // sentence rather than only the part that fit on line one.
        const labelAt =
          lineOff[c.lineStart] + c.rawCol + (c.raw.length - rest.length);
        const labelEnd = lineOff[c.lineStart + c.lineSpan - 1] + c.endCol;
        token.items.push({
          checked: c.checked,
          human,
          blocking,
          id,
          raw: c.raw,
          labelSrc: [labelAt, labelEnd] as [number, number],
          tokens: this.lexer.inlineTokens(rest),
          // Indented `override:` / `evidence:` lines attach to the criterion
          // above them; all other non-matching lines stay dropped.
          notes: c.notes.length
            ? c.notes.map((n) => ({
                kind: n.kind,
                tokens: this.lexer.inlineTokens(n.text),
              }))
            : undefined,
        });
      }
    } else {
      this.lexer.blockTokens(body, token.tokens);
    }
    return token;
  },
  renderer(this: any, token: any) {
    // Collapsible section — its OWN type, distinct from plain `## Phase` headings.
    if (token.name === "collapse" || token.name === "section") {
      const [title, sub] = token.args.split("|").map((s: string) => s.trim());
      const inner = this.parser.parse(token.tokens);
      return (
        `<details class="wp-collapse">` +
        `<summary data-outline="${escAttr(title || "Section")}">` +
        CARET +
        `<span class="wp-col-head">` +
        `<span class="wp-col-title">${esc(title || "")}</span>` +
        (sub ? `<span class="wp-col-sub">${esc(sub)}</span>` : "") +
        `</span></summary>` +
        `<div class="wp-col-body">${inner}</div></details>`
      );
    }
    // Callout family: :::note / :::assumption / :::decision
    // (+ common aliases). The optional args act as a custom label; otherwise a
    // default per type. Each merged source block renders as its own
    // `.wp-callout-entry` (dividers are CSS, not `<hr>`); reviewable types get
    // data-callout/data-callout-ord so entries are individually addressable.
    // The wrappers must contribute no text nodes — comment anchors are
    // character offsets into the document text.
    if (token.name in CALLOUT_LABELS) {
      const metas: (CalloutMeta | undefined)[] = token.metas ?? [token.meta];
      const label = metas[0]?.label || CALLOUT_LABELS[token.name];
      // The first entry's chips ride the header row rather than claiming a
      // line under it — the header sits directly above that entry, and the
      // chips are text-free, so hoisting them moves no document character.
      const headChips = chipsHtml(metas[0], token.name);
      const head =
        label || headChips
          ? `<div class="wp-callout-head">` +
            (label ? `<span class="wp-callout-label">${esc(label)}</span>` : "") +
            headChips +
            `</div>`
          : "";
      const entries: any[][] = token.entries ?? [token.tokens];
      const ords: (number | undefined)[] = token.ords ?? [];
      const body = entries
        .map((toks, i) => {
          const meta = metas[i];
          let attrs =
            ords[i] != null
              ? ` data-callout="${escAttr(token.name)}" data-callout-ord="${ords[i]}"`
              : "";
          if (ords[i] != null && meta?.id)
            attrs += ` data-callout-id="${escAttr(meta.id)}"`;
          // ID badge and chips are text-free (labels are CSS generated content)
          // so comment offsets and stored verdicts survive a status upgrade, a
          // late-added ID, or a revision stamp. The ID trails the entry's last
          // word instead of heading a row of its own; entry 0's chips sit in
          // the header row, later entries carry their own above their prose;
          // and the narrow right rail is left to the feedback UI.
          const idHtml = meta?.id
            ? `<span class="wp-id" data-id="${escAttr(meta.id)}"></span>`
            : "";
          const chips = i === 0 ? "" : chipsHtml(meta, token.name);
          const metaRow = chips ? `<div class="wp-entry-meta">${chips}</div>` : "";
          const parsed = this.parser.parse(toks);
          const prose = idHtml ? withTrailingMarker(parsed, idHtml) : parsed;
          // Reviewable entries get the rail the feedback UI docks into.
          const railed = ords[i] != null;
          const rail = railed ? `<div class="wp-entry-rail"></div>` : "";
          return (
            `<div class="wp-callout-entry${railed ? " has-rail" : ""}"${attrs}>` +
            `<div class="wp-entry-body">${metaRow}${prose}</div>` +
            rail +
            `</div>`
          );
        })
        // Joined with "\n" to reproduce the text node the old `<hr>\n` divider
        // emitted — keeps document text byte-identical, so stored comment
        // offsets from earlier builds keep resolving.
        .join("\n");
      return (
        `<aside class="wp-callout wp-callout--${token.name}">` +
        head +
        body +
        `</aside>`
      );
    }
    if (token.name === "checklist") {
      const rows = token.items
        .map((it: any) => {
          const idHtml = it.id
            ? `<span class="wp-id" data-id="${escAttr(it.id)}"></span>`
            : "";
          const label = `<span class="wp-check-label"${blkAttr(it)}>${this.parser.parseInline(it.tokens)}</span>`;
          // Override/evidence notes are content, not metadata — real
          // selectable text. The wrapper only exists when notes do, so plain
          // rows are untouched.
          const main = it.notes?.length
            ? `<span class="wp-check-main">${label}${it.notes
                .map(
                  (n: any) =>
                    `<span class="wp-check-note wp-check-note--${n.kind}">${this.parser.parseInline(n.tokens)}</span>`,
                )
                .join("")}</span>`
            : label;
          const evidenced = it.notes?.some((n: any) => n.kind === "evidence");
          return (
            `<li class="wp-check${it.checked ? " is-checked" : ""}${it.human ? " wp-check--human" : ""}${it.blocking ? " wp-check--blocking" : ""}${evidenced ? " wp-check--evidenced" : ""}" data-keep="1" data-raw="${escAttr(it.raw)}">` +
            `<span class="wp-check-box">${CHECK}</span>` +
            idHtml +
            main +
            (it.human ? `<span class="wp-check-human-badge">Human</span>` : "") +
            `</li>`
          );
        })
        .join("");
      const title = token.args
        ? `<h3 class="wp-checklist-title" data-outline="${escAttr(token.args)}">${esc(token.args)}</h3>`
        : "";
      return (
        `<div class="wp-checklist">` +
        title +
        `<ul class="wp-check-list">${rows}</ul>` +
        `<button type="button" class="wp-check-add" data-keep="1">${PLUS}<span>Add acceptance criteria</span></button>` +
        `</div>`
      );
    }
    return token.raw;
  },
};

/* ---------------- source offsets ---------------- *
 * Every unit a reviewer may edit in place carries `data-blk="<start>:<end>"`,
 * the byte range of its markdown in the plan file. That is what lets a typed
 * change be written back as a minimal splice instead of a re-serialization —
 * see lib/srcmap.ts. Code fences and mermaid deliberately get no range: hljs
 * and mermaid rewrite that DOM after render, so it is never editable.
 */

/** Content spans of a table row's cells, trimmed, ignoring escaped pipes. */
function pipeCells(line: string): [number, number][] {
  const bars: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "|" && line[i - 1] !== "\\") bars.push(i);
  }
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < bars.length; i++) {
    let a = bars[i] + 1;
    let b = bars[i + 1];
    while (a < b && /\s/.test(line[a])) a++;
    while (b > a && /\s/.test(line[b - 1])) b--;
    out.push([a, b]);
  }
  return out;
}

/** Table cells carry no `raw`, so locate them by row line and pipe position. */
function stampTable(t: any): void {
  const start = t.src[0];
  const lines: string[] = t.raw.split("\n");
  const lineAt: number[] = [];
  let off = 0;
  for (const line of lines) {
    lineAt.push(off);
    off += line.length + 1;
  }
  const row = (i: number, cells: any[]) => {
    if (lines[i] == null || !Array.isArray(cells)) return;
    const spans = pipeCells(lines[i]);
    // A borderless GFM table yields a different cell count; leave it unmapped
    // rather than splice into the wrong column.
    if (spans.length !== cells.length) return;
    cells.forEach((c, k) => {
      c.src = [start + lineAt[i] + spans[k][0], start + lineAt[i] + spans[k][1]];
    });
  };
  row(0, t.header);
  // Row r sits two lines below the header: the alignment row is between them.
  (t.rows ?? []).forEach((cells: any[], r: number) => row(r + 2, cells));
}

function descend(t: any): void {
  const start = t.src[0];
  if (t.type === "container") {
    const base = start + t.bodyOff;
    if (t.name === "checklist") {
      for (const it of t.items) {
        if (it.labelSrc) it.src = [base + it.labelSrc[0], base + it.labelSrc[1]];
      }
    } else if (t.tokens?.length) {
      stampSource(t.tokens, t.body, base);
    }
  } else if (t.type === "list") {
    stampSource(t.items ?? [], t.raw, start);
  } else if (t.type === "list_item") {
    stampSource(t.tokens ?? [], t.raw, start);
  } else if (t.type === "table") {
    stampTable(t);
  }
}

/**
 * Stamp each token with the byte range of its `raw` in the plan source. Every
 * child is located inside its parent's `raw` with a forward-only `indexOf`, so
 * a token whose text the lexer rewrote (a blockquote strips its `>` markers)
 * simply goes unmapped and that subtree stays read-only — the mapping fails
 * closed rather than guessing.
 *
 * Runs before `mergeCallouts`, which splices the token array and would destroy
 * the 1:1 token↔source correspondence this depends on.
 */
function stampSource(tokens: any[], parentRaw: string, parentStart: number): void {
  let cursor = 0;
  for (const t of tokens) {
    if (!t || typeof t.raw !== "string" || !t.raw) continue;
    const at = parentRaw.indexOf(t.raw, cursor);
    if (at === -1) continue;
    t.src = [parentStart + at, parentStart + at + t.raw.length];
    cursor = at + t.raw.length;
    descend(t);
  }
}

const blkAttr = (t: any) =>
  t?.src ? ` data-blk="${t.src[0]}:${t.src[1]}"` : "";

/** Inject `data-blk` into the opening tag of a default-rendered block. */
const withBlk = (html: string, t: any) =>
  t?.src ? html.replace(/^(\s*<[a-zA-Z][\w-]*)/, `$1${blkAttr(t)}`) : html;

const base = new Renderer();

/** code fence: ```lang filename  →  figure with a filename tab */
const renderer = {
  heading(this: any, token: any) {
    return withBlk(base.heading.call(this, token), token);
  },
  paragraph(this: any, token: any) {
    return withBlk(base.paragraph.call(this, token), token);
  },
  listitem(this: any, token: any) {
    return withBlk(base.listitem.call(this, token), token);
  },
  tablecell(this: any, token: any) {
    return withBlk(base.tablecell.call(this, token), token);
  },
  // Inline code that names a repo file is marked as a candidate reference —
  // path and line as attributes, the rendered text untouched. The viewer only
  // turns candidates the host can actually resolve into links, so a span like
  // `v1.2` (a candidate by shape) stays ordinary code.
  codespan(this: any, token: Tokens.Codespan) {
    const html = base.codespan.call(this, token);
    const ref = parseFileRef(token.text);
    if (!ref) return html;
    const attrs =
      ` class="wp-ref" data-path="${escAttr(ref.path)}"` +
      (ref.line != null ? ` data-line="${ref.line}"` : "");
    return html.replace(/^(\s*<code)/, `$1${attrs}`);
  },
  code(this: any, token: Tokens.Code) {
    const info = (token.lang || "").trim();
    const sp = info.search(/\s/);
    const language = sp === -1 ? info : info.slice(0, sp);
    // Mermaid fences get a distinct figure the viewer renders client-side. The
    // source lives in a bare <code> (not <pre>), so the hljs pass — which
    // selects `pre code` — never touches it; the SVG is produced by mermaid
    // (securityLevel:strict), not this markdown sanitizer.
    if (language === "mermaid") {
      return (
        `<figure class="wp-mermaid">` +
        `<code class="wp-mermaid-src">${esc(token.text)}</code>` +
        `<div class="wp-mermaid-out" aria-hidden="true"></div>` +
        `</figure>`
      );
    }
    const file = sp === -1 ? "" : info.slice(sp + 1).trim();
    const cls = language ? ` class="language-${esc(language)}"` : "";
    const cap = file
      ? `<figcaption class="wp-code-file">${esc(file)}</figcaption>`
      : "";
    return `<figure class="wp-code">${cap}<pre><code${cls}>${esc(token.text)}</code></pre></figure>`;
  },
};

marked.use({ gfm: true, extensions: [container], renderer });

/**
 * Merge runs of consecutive same-type callouts (e.g. several `:::assumption`
 * blocks in a row) into a single callout, so they render as one colored block
 * with one label and a thin divider between entries. Each source block is kept
 * as a separate entry (`token.entries`) so the renderer can wrap it in an
 * addressable `.wp-callout-entry`; reviewable types get a 1-based per-type
 * ordinal (`token.ords`) in document order, walked depth-first. Recurses into
 * nested block containers. Mutates the token array in place.
 */
function mergeCallouts(
  tokens: any[],
  counters: Record<string, number> = {},
): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t?.tokens && Array.isArray(t.tokens)) mergeCallouts(t.tokens, counters);
    if (t?.type !== "container" || !(t.name in CALLOUT_LABELS)) continue;

    t.entries = [t.tokens];
    t.metas = [t.meta];
    // Absorb following same-type callouts (skipping the blank-line `space`
    // tokens the lexer inserts between blocks).
    while (i + 1 < tokens.length) {
      let k = i + 1;
      if (tokens[k]?.type === "space") k++;
      const next = tokens[k];
      if (next?.type !== "container" || next.name !== t.name) break;
      if (next.tokens?.length) mergeCallouts(next.tokens, counters);
      t.entries.push(next.tokens || []);
      t.metas.push(next.meta);
      tokens.splice(i + 1, k - i); // drop the space(s) + the absorbed callout
    }
    if (REVIEWABLE_CALLOUTS.has(t.name)) {
      t.ords = t.entries.map(
        () => (counters[t.name] = (counters[t.name] ?? 0) + 1),
      );
    }
  }
}

/** Attributes the viewer needs to survive sanitization. */
const PLAN_ATTRS = [
  "open", "data-keep", "data-outline", "data-callout", "data-callout-ord",
  "data-callout-id", "data-raw", "data-id", "data-ref", "data-rev", "data-blk",
  "data-path", "data-line", "contenteditable",
];

/**
 * Sanitize plan HTML, keeping the attributes the viewer addresses elements by.
 * Exported so the redline merge — which splices two already-rendered documents
 * together — can be re-sanitized without losing `data-blk` and friends.
 */
export function sanitizePlanHtml(html: string): string {
  return DOMPurify.sanitize(html, { ADD_ATTR: PLAN_ATTRS });
}

/** Render Waypoint Plan Markdown to sanitized HTML. */
export function renderMarkdown(md: string): string {
  const tokens = marked.lexer(md);
  stampSource(tokens, md, 0);
  mergeCallouts(tokens);
  return sanitizePlanHtml(marked.parser(tokens));
}
