<script lang="ts">
  import { tick } from "svelte";
  import hljs from "highlight.js";
  import mermaid from "mermaid";
  import { renderMarkdown, sanitizePlanHtml } from "../lib/markdown";
  import { htmldiff } from "../lib/htmldiff";
  import {
    offsetsFromSelection,
    rangeFromOffsets,
    textWalker,
    type SelectionAnchor,
  } from "../lib/anchor";
  import {
    alignTextToSource,
    blkRange,
    ownText,
    spliceFromEdit,
    type Splice,
  } from "../lib/srcmap";
  import { relativeTime } from "../lib/format";
  import { createDwellTracker } from "../lib/dwell";
  import { diagramMermaidConfig, fitDiagram } from "../lib/diagram";
  import {
    CARD_DEFAULT_W,
    CARD_MIN_W,
    clampCardWidth,
    loadCardWidth,
    saveCardWidth,
  } from "../lib/layout";
  import { readingAnchor, restoreReading, type ReadingAnchor } from "../lib/reading";
  import {
    bindVerdicts,
    handleCalloutClick,
    injectCalloutUI,
    type EntryAnchor,
  } from "../lib/calloutFeedback";
  import Icon from "./Icon.svelte";
  import Button from "./Button.svelte";
  import type { CalloutVerdict, Comment, TextShift } from "../../shared/review";
  import type { ClientInteraction } from "../../shared/interactionLog";

  let {
    markdown = "",
    baseline = "",
    loading = false,
    comments = [],
    activeId = null,
    readOnly = false,
    dimmed = false,
    theme = "light",
    onAdd,
    onDelete,
    onActivate,
    onVerdict,
    onAddCriterion,
    onRemoveCriterion,
    onSetCriterion,
    onEditText,
    onEditing,
    onTextShift,
    onUiEvent,
    onResolveRefs,
    onOpenRef,
  }: {
    markdown: string;
    /**
     * The plan as it stood when this round of inline edits began, or "" when
     * there have been none. Non-empty turns the document into a redline of it
     * against `markdown`.
     */
    baseline?: string;
    loading: boolean;
    comments: Comment[];
    activeId: string | null;
    readOnly?: boolean;
    /** Grey the prose out: it is about to be replaced by a new version. */
    dimmed?: boolean;
    theme?: "light" | "dark";
    onAdd: (c: {
      quote: string;
      start: number;
      end: number;
      body: string;
      crossCutting?: boolean;
    }) => void;
    onDelete: (id: string) => void;
    onActivate: (id: string | null) => void;
    onVerdict: (d: EntryAnchor & { verdict: CalloutVerdict }) => void;
    onAddCriterion: (d: { ord: number; text: string }) => void;
    onRemoveCriterion: (d: { ord: number; text: string }) => void;
    onSetCriterion: (d: { ord: number; text: string; checked: boolean }) => void;
    /** Write one inline edit through to the plan file. */
    onEditText: (s: Splice) => Promise<{ ok: boolean; markdown: string }>;
    /**
     * A caret is (or is no longer) in the document. While it is, the parent
     * holds back file-watcher re-renders — they would replace the DOM the
     * reviewer is typing into. The markdown handed back on close is what the
     * file now says.
     */
    onEditing: (active: boolean, markdown?: string) => void | Promise<void>;
    /** An edit moved the rendered text — comment anchors must follow it. */
    onTextShift: (d: TextShift) => void;
    /** UI-only interaction happened (drafts, resize, outline nav, edits). */
    onUiEvent: (i: ClientInteraction) => void;
    /**
     * File references: `onResolveRefs` reports which candidate paths name a
     * real file (only those become links); `onOpenRef` opens one beside the
     * plan. Both are host round-trips, injected so this component stays
     * host-agnostic.
     */
    onResolveRefs: (paths: string[]) => Promise<Record<string, boolean>>;
    onOpenRef: (path: string, line?: number) => void;
  } = $props();

  // Layout geometry: the document card is `artW` wide and left-aligned; the
  // comment margin hangs off its right edge. Width persists across reloads
  // and is mirrored by DiffDocument.
  const COM_W = 280;
  const GAP = 12;
  let artW = $state(loadCardWidth());
  const comLeft = $derived(artW + GAP);

  /* ---------------- card resize (drag the right border) ---------------- */
  let dragging: { startX: number; startW: number } | null = null;

  function startDrag(e: PointerEvent) {
    dragging = { startX: e.clientX, startW: artW };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function dragMove(e: PointerEvent) {
    if (!dragging) return;
    const panelMax = Math.max(CARD_MIN_W, window.innerWidth - 32);
    const next = dragging.startW + (e.clientX - dragging.startX);
    artW = Math.min(panelMax, clampCardWidth(next));
  }
  function endDrag() {
    if (!dragging) return;
    const previousWidthPx = dragging.startW;
    dragging = null;
    saveCardWidth(artW);
    settle();
    if (previousWidthPx !== artW)
      onUiEvent({ type: "card_resized", widthPx: artW, previousWidthPx });
  }
  function resetWidth() {
    const previousWidthPx = artW;
    artW = CARD_DEFAULT_W;
    saveCardWidth(artW);
    settle();
    if (previousWidthPx !== artW)
      onUiEvent({ type: "card_resized", widthPx: artW, previousWidthPx });
  }

  // Invisible grab zone straddling the card border. The resize cursor is the
  // whole affordance — a line lighting up alongside the plan text read as part
  // of the document rather than as chrome.
  const handleCls =
    "absolute top-10 bottom-[60vh] z-10 w-[9px] cursor-ew-resize touch-none";

  // With an edit-session baseline in hand the document renders as a redline of
  // it against the live plan: additions highlighted, deletions struck in place.
  // The plan file itself stays clean markdown — the redline is a view, so
  // tick.py and every other reader of the file are unaffected.
  const html = $derived(
    !markdown
      ? ""
      : baseline
        ? sanitizePlanHtml(
            htmldiff(renderMarkdown(baseline), renderMarkdown(markdown)),
          )
        : renderMarkdown(markdown),
  );

  let mainEl = $state<HTMLElement>();
  let contentEl = $state<HTMLElement>();
  let docEl = $state<HTMLElement>();

  // Card element refs, by comment id (plain object — bind:this assigns into it).
  const cardRefs: Record<string, HTMLElement | null> = {};
  // Resolved vertical position per card (px from content-wrapper top).
  let positions = $state<Record<string, number>>({});

  // In-progress (unsaved) comment being composed in the margin.
  type Draft = { id: string; start: number; end: number; quote: string };
  let draft = $state<Draft | null>(null);
  let composeBody = $state("");
  // Cross-cutting: this comment asks for a whole-plan revision pass (ADJ-15).
  let composeCross = $state(false);

  // Floating "Comment" selection toolbar.
  let toolbar = $state<{ visible: boolean; x: number; y: number }>({
    visible: false,
    x: 0,
    y: 0,
  });
  let pending: SelectionAnchor | null = null;
  let toolbarRange: Range | null = null;

  // Outline rail — parked for now (the dots read as decoration next to the
  // phase pills in the header). Flip to true to bring it back: everything
  // behind it still runs, because the section dwell log is derived from the
  // same heading scan.
  const OUTLINE_RAIL = false;
  let headings = $state<{ id: string; label: string }[]>([]);
  // `##` sections only — the dwell log's candidate set (see updateDwellSection).
  let dwellSections: { id: string; label: string }[] = [];
  let activeSection = $state<string>("");
  let navHover = $state(false);

  // Bare verdict records (empty body) render as badges on their callout entry,
  // not as margin cards; only bodied comments get cards/underlines.
  const bodied = $derived(comments.filter((c) => c.body));
  const allCards = $derived(
    draft ? [...bodied, { ...draft, body: "", createdAt: Date.now(), composing: true } as any] : bodied,
  );

  /* ---------------- file references ---------------- */
  // markdown.ts marks every code span *shaped* like a repo path; the host says
  // which ones exist. Only those get `is-linked` (the pointer + underline the
  // click handler keys on), so a span like `v1.2` stays ordinary code. Results
  // are cached across renders — a plan cites the same files every time — and a
  // late-arriving answer for a superseded render is dropped.
  const refCache = new Map<string, boolean>();
  let refPass = 0;
  $effect(() => {
    void html;
    if (!docEl) return;
    const pass = ++refPass;
    const spans = [...docEl.querySelectorAll("code[data-path]")] as HTMLElement[];
    if (!spans.length) return;
    const paint = () => {
      for (const span of spans) {
        const path = span.getAttribute("data-path")!;
        if (!refCache.get(path)) continue;
        span.classList.add("is-linked");
        const line = span.getAttribute("data-line");
        span.title = line ? `Open ${path}:${line}` : `Open ${path}`;
      }
    };
    const unknown = [
      ...new Set(
        spans
          .map((s) => s.getAttribute("data-path")!)
          .filter((p) => !refCache.has(p)),
      ),
    ];
    if (!unknown.length) return void paint();
    void onResolveRefs(unknown)
      .then((resolved) => {
        for (const path of unknown) refCache.set(path, !!resolved?.[path]);
        if (pass === refPass && docEl?.isConnected) paint();
      })
      .catch(() => {});
  });

  /* ---------------- syntax highlight ---------------- */
  $effect(() => {
    void html;
    if (!docEl) return;
    for (const block of docEl.querySelectorAll("pre code")) {
      try {
        hljs.highlightElement(block as HTMLElement);
      } catch {}
    }
  });

  /* ---------------- mermaid diagrams ---------------- */
  // Render each `.wp-mermaid` figure (emitted by markdown.ts) into an SVG.
  // Re-runs when the plan text or the viewer theme changes. Mermaid produces
  // its own sanitized SVG (securityLevel:strict); the plan sanitizer is
  // bypassed for this subtree by design. A parse error shows source + message
  // rather than blanking the plan.
  // Bumped once a diagram finishes rendering. The comment-highlight and card-
  // settle effects read it so they re-anchor after mermaid injects SVG text —
  // otherwise a reloaded comment sitting *after* a diagram would be positioned
  // against the pre-render DOM (no SVG text) and never realign.
  let mermaidTick = $state(0);
  $effect(() => {
    void html;
    const t = theme; // re-render on theme toggle
    if (!docEl) return;
    const figs = docEl.querySelectorAll(".wp-mermaid");
    if (!figs.length) return;
    mermaid.initialize(
      diagramMermaidConfig(t, getComputedStyle(docEl).fontFamily),
    );
    figs.forEach(async (fig, i) => {
      const src =
        (fig.querySelector(".wp-mermaid-src") as HTMLElement)?.textContent ?? "";
      const out = fig.querySelector(".wp-mermaid-out") as HTMLElement | null;
      if (!out || !src.trim()) return;
      try {
        const { svg } = await mermaid.render(`wp-mmd-${i}`, src);
        out.innerHTML = svg;
        sizeDiagram(fig as HTMLElement);
      } catch (e) {
        out.innerHTML = "";
        const pre = document.createElement("pre");
        pre.className = "wp-mermaid-err";
        pre.textContent = `Diagram error: ${String(e)}\n\n${src}`;
        out.appendChild(pre);
        fig.classList.remove("wp-mermaid-scroll");
      }
      // After sizing, never before: comments re-anchor off this tick and the
      // SVG's own width is still moving until sizeDiagram has run (#A2).
      mermaidTick++;
    });
  });

  // Replace mermaid's fit-the-container sizing with our own: hold a legibility
  // floor and let anything wider scroll. Idempotent — the re-fit effect below
  // runs it again over already-rendered SVGs on every card resize.
  function sizeDiagram(fig: HTMLElement): void {
    const out = fig.querySelector(".wp-mermaid-out") as HTMLElement | null;
    const svg = out?.querySelector("svg") as SVGSVGElement | null;
    if (!out || !svg) return;
    const natural = svg.viewBox?.baseVal?.width || parseFloat(svg.style.maxWidth) || 0;
    const fit = fitDiagram(natural, out.clientWidth);
    svg.style.maxWidth = "none";
    svg.style.width = `${fit.width}px`;
    svg.style.height = "auto";
    fig.classList.toggle("wp-mermaid-scroll", fit.scroll);
  }

  // Re-fit on card resize. Reads `mermaidTick` (to run once diagrams exist)
  // but must never bump it, or this effect re-triggers itself.
  $effect(() => {
    void artW;
    void mermaidTick;
    if (!docEl) return;
    for (const fig of docEl.querySelectorAll(".wp-mermaid"))
      sizeDiagram(fig as HTMLElement);
  });

  /* ---------------- inline highlights ---------------- */
  $effect(() => {
    void html;
    void activeId;
    void comments.length;
    void draft;
    void mermaidTick;
    const api = (CSS as any).highlights;
    if (!docEl || !api) return;
    const Hl = (window as any).Highlight;
    const base = new Hl();
    const active = new Hl();
    for (const c of bodied) {
      const r = rangeFromOffsets(docEl, c.start, c.end);
      if (r) (c.id === activeId ? active : base).add(r);
    }
    if (draft) {
      const r = rangeFromOffsets(docEl, draft.start, draft.end);
      if (r) active.add(r);
    }
    api.set("comment", base);
    api.set("comment-active", active);
    return () => {
      api.delete("comment");
      api.delete("comment-active");
    };
  });

  /* ---------------- outline ---------------- */
  $effect(() => {
    void html;
    if (!docEl) return;
    queueMicrotask(() => buildOutline());
  });

  function buildOutline() {
    if (!docEl) return;
    const hs = [
      ...docEl.querySelectorAll("h1, h2, summary[data-outline]"),
    ] as HTMLElement[];
    headings = hs.map((h, i) => {
      if (!h.id) h.id = "wp-sec-" + i;
      const label =
        h.getAttribute("data-outline") ||
        (i === 0 ? "Overview" : h.textContent || "Section");
      return { id: h.id, label };
    });
    dwellSections = hs
      .filter((h) => h.tagName === "H2")
      .map((h) => ({ id: h.id, label: h.textContent || "Section" }));
    updateActiveSection();
    updateDwellSection();
  }

  // Reading-behavior log: engaged time per section, batched (see lib/dwell).
  const dwell = createDwellTracker({
    onFlush: (dwells, sectionCount) =>
      onUiEvent({ type: "section_dwell", sectionCount, dwells }),
  });

  function updateActiveSection() {
    if (!mainEl || !headings.length) return;
    const mt = mainEl.getBoundingClientRect().top;
    let active = headings[0].id;
    for (const { id } of headings) {
      const el = docEl?.querySelector("#" + CSS.escape(id)) as HTMLElement | null;
      if (!el) continue;
      if (el.getBoundingClientRect().top - mt <= 130) active = id;
      else break;
    }
    if (active !== activeSection) activeSection = active;
  }

  // Dwell attribution is coarser than the outline highlight: only `##`
  // sections count, and time goes to the one occupying the largest share of
  // the viewport — a section showing a sliver never wins the attribution.
  function updateDwellSection() {
    if (!mainEl || !docEl || !dwellSections.length) return;
    const count = dwellSections.length;
    const mt = mainEl.getBoundingClientRect().top;
    const mb = mt + mainEl.clientHeight;
    const docBottom = docEl.getBoundingClientRect().bottom;
    const secEl = (i: number): HTMLElement | null => {
      const s = dwellSections[i];
      return s
        ? (docEl!.querySelector("#" + CSS.escape(s.id)) as HTMLElement | null)
        : null;
    };
    let best = -1;
    let bestOverlap = 0;
    for (let i = 0; i < count; i++) {
      const el = secEl(i);
      if (!el) continue;
      const top = el.getBoundingClientRect().top;
      const bottom = secEl(i + 1)?.getBoundingClientRect().top ?? docBottom;
      const overlap = Math.min(mb, bottom) - Math.max(mt, top);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = i;
      }
    }
    if (best >= 0) dwell.setSection(best, count, dwellSections[best].label);
    else dwell.setSection(-1, count, "");
  }

  function scrollToSection(id: string) {
    if (!docEl) return;
    const el = docEl.querySelector("#" + CSS.escape(id)) as HTMLElement | null;
    if (el) scrollToEl(el);
  }

  function scrollToEl(el: HTMLElement) {
    if (!mainEl) return;
    const mt = mainEl.getBoundingClientRect().top;
    const top = Math.max(0, el.getBoundingClientRect().top - mt + mainEl.scrollTop - 28);
    mainEl.scrollTo({ top, behavior: "smooth" });
  }

  /** Jump to a `## …` section by its heading text — the phase-pill target.
   * Falls back to a `Phase N` prefix match, since rendered textContent can
   * drift from the raw markdown title (inline code, etc.). */
  export function scrollToHeading(title: string) {
    if (!docEl) return;
    const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
    const want = norm(title);
    const hs = [...docEl.querySelectorAll("h2")] as HTMLElement[];
    let hit = hs.find((h) => norm(h.textContent) === want);
    if (!hit) {
      const m = /^phase\s+\d+/.exec(want);
      if (m) {
        const re = new RegExp("^" + m[0].replace(/\s+/g, "\\s+") + "\\b");
        hit = hs.find((h) => re.test(norm(h.textContent)));
      }
    }
    if (hit) scrollToEl(hit);
  }

  /* ---------------- comment card layout (settle loop) ---------------- */
  // Re-run measurement every ~60ms until the computed tops stay stable for a
  // few frames or a cap is hit — immune to fonts/highlighting reflowing late.
  let settleT: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    void html;
    void comments;
    void draft;
    void activeId;
    void mermaidTick;
    void artW; // card resize reflows the text → re-anchor the margin cards
    settle();
  });

  function measureTops(): Record<string, number> | null {
    if (!contentEl || !docEl) return null;
    const cards = allCards;
    if (!cards.length) return {};
    const wrapTop = contentEl.getBoundingClientRect().top;
    const items = cards.map((c: any) => {
      const r = rangeFromOffsets(docEl!, c.start, c.end);
      const top = r ? r.getBoundingClientRect().top - wrapTop : 0;
      const el = cardRefs[c.id];
      return { id: c.id, top, h: el ? el.offsetHeight : 0 };
    });
    // Not measurable yet (a card still has 0 height) → keep polling.
    for (const it of items) if (it.h === 0) return null;
    items.sort((a, b) => a.top - b.top);
    let prev = 8;
    const gap = 10;
    const out: Record<string, number> = {};
    for (const it of items) {
      const top = Math.max(it.top, prev + gap);
      out[it.id] = top;
      prev = top + it.h;
    }
    return out;
  }

  function settle() {
    if (settleT) clearTimeout(settleT);
    let ticks = 0;
    let stable = 0;
    let prev: string | null = null;
    const tick = () => {
      const tops = measureTops();
      const sig = tops ? JSON.stringify(tops) : null;
      if (tops) positions = tops;
      if (sig !== null && sig === prev) stable += 1;
      else stable = 0;
      prev = sig;
      ticks += 1;
      if ((sig !== null && stable >= 3) || ticks > 40) settleT = null;
      else settleT = setTimeout(tick, 60);
    };
    tick();
  }

  /* ---------------- selection / commenting ---------------- */
  function computeToolbarPos(range: Range) {
    if (!contentEl) return { x: 0, y: 0 };
    const rect = range.getBoundingClientRect();
    const cRect = contentEl.getBoundingClientRect();
    let y = rect.top;
    const bh = 34;
    const gap = 8;
    const cards = Object.values(cardRefs)
      .filter(Boolean)
      .map((el) => (el as HTMLElement).getBoundingClientRect());
    let moved = true;
    let guard = 0;
    while (moved && guard++ < 24) {
      moved = false;
      for (const cr of cards) {
        if (y < cr.bottom + gap && y + bh > cr.top - gap) {
          y = cr.bottom + gap;
          moved = true;
        }
      }
    }
    return { x: cRect.left + comLeft, y };
  }

  function clearToolbar() {
    toolbarRange = null;
    pending = null;
    if (toolbar.visible) toolbar = { visible: false, x: 0, y: 0 };
  }

  function offsetFromPoint(x: number, y: number): number | null {
    if (!docEl) return null;
    let node: Node | null = null;
    let off = 0;
    const doc = document as any;
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      if (!p) return null;
      node = p.offsetNode;
      off = p.offset;
    } else if (doc.caretRangeFromPoint) {
      const r = doc.caretRangeFromPoint(x, y);
      if (!r) return null;
      node = r.startContainer;
      off = r.startOffset;
    } else return null;
    if (!node || !docEl.contains(node)) return null;
    const pre = document.createRange();
    pre.setStart(docEl, 0);
    pre.setEnd(node, off);
    return pre.toString().length;
  }

  function activateAtPoint(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (t.closest && (t.closest("[data-card]") || t.closest("[data-keep]"))) return;
    const off = offsetFromPoint(e.clientX, e.clientY);
    if (off == null) {
      onActivate(null);
      return;
    }
    const hit = bodied.find((c) => off >= c.start && off <= c.end);
    onActivate(hit ? hit.id : null);
  }

  function onMouseUp(e: MouseEvent) {
    if (draft) return;
    if (e.detail > 1) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      clearToolbar();
      return;
    }
    if (sel.isCollapsed) {
      activateAtPoint(e);
      clearToolbar();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!docEl || !docEl.contains(range.commonAncestorContainer)) {
      clearToolbar();
      return;
    }
    if (readOnly) {
      clearToolbar();
      return;
    }
    const anc = offsetsFromSelection(docEl);
    if (!anc) {
      clearToolbar();
      return;
    }
    toolbarRange = range.cloneRange();
    pending = anc;
    const pos = computeToolbarPos(range);
    toolbar = { visible: true, x: pos.x, y: pos.y };
  }

  function repositionToolbar() {
    if (!toolbar.visible || !toolbarRange) return;
    const pos = computeToolbarPos(toolbarRange);
    toolbar = { ...toolbar, x: pos.x, y: pos.y };
  }

  function createDraft() {
    if (!pending) return;
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "d" + Date.now();
    draft = { id, start: pending.start, end: pending.end, quote: pending.quote };
    composeBody = "";
    onUiEvent({ type: "comment_draft_opened", draftId: id, quoteLength: pending.quote.length });
    clearToolbar();
    window.getSelection()?.removeAllRanges();
    onActivate(id);
  }

  function submitDraft() {
    if (!draft) return;
    const body = composeBody.trim();
    if (body)
      onAdd({
        quote: draft.quote,
        start: draft.start,
        end: draft.end,
        body,
        crossCutting: composeCross || undefined,
      });
    draft = null;
    composeBody = "";
    composeCross = false;
    onActivate(null);
  }

  function cancelDraft() {
    if (draft) onUiEvent({ type: "comment_draft_cancelled", draftId: draft.id });
    draft = null;
    composeBody = "";
    composeCross = false;
    onActivate(null);
  }

  function onScroll() {
    repositionToolbar();
    updateActiveSection();
    updateDwellSection();
  }

  /* ---------------- checklist interaction (event delegation) ---------------- */
  // Adds, deletes, and checkbox ticks all write through to the plan file (the
  // DOM change is only an optimistic preview until the file watcher
  // re-renders) — the plan file is the single source of truth.
  const CHECK_SVG =
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l3.5 3.5L16 5.5"/></svg>';
  const DEL_SVG =
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8"/></svg>';

  function makeDeleteBtn(): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wp-check-del";
    b.setAttribute("data-keep", "1");
    b.setAttribute("aria-label", "Remove criterion");
    b.innerHTML = DEL_SVG;
    return b;
  }

  // Give every rendered acceptance criterion a hover × to remove it (session-
  // only, mirroring "Add acceptance criteria").
  $effect(() => {
    void html;
    if (!docEl) return;
    for (const li of docEl.querySelectorAll(".wp-check")) {
      if (!li.querySelector(".wp-check-del")) li.appendChild(makeDeleteBtn());
    }
  });

  // Asserted-tick styling is document-opt-in: only a plan that carries any
  // `evidence:` note gets the warning style on bare non-@human ticks, so
  // legacy plans render untouched.
  $effect(() => {
    void html;
    if (!docEl) return;
    docEl.classList.toggle(
      "wp-has-evidence",
      !!docEl.querySelector(".wp-check-note--evidence"),
    );
  });

  /* ---------------- callout feedback (reject / comment) ---------------- */
  // Sealed versions still show badges (from resolved records) but get no action
  // buttons. Injected nodes contribute no document text — see calloutFeedback.ts.
  $effect(() => {
    void html;
    if (!docEl) return;
    injectCalloutUI(docEl, readOnly);
  });

  $effect(() => {
    void html;
    void comments;
    void mermaidTick;
    if (!docEl) return;
    bindVerdicts(docEl, comments);
  });

  // The Comment action reuses the standard compose card, pre-anchored to the
  // entry's text range (no selection step).
  function beginCalloutComment(a: EntryAnchor) {
    if (readOnly || draft) return;
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "d" + Date.now();
    draft = { id, start: a.start, end: a.end, quote: a.quote };
    composeBody = "";
    clearToolbar();
    window.getSelection()?.removeAllRanges();
    onActivate(id);
  }

  // Address a checklist by its 0-based document-order index — the same
  // convention the callout verdicts use for entry ordinals.
  function checklistOrd(from: Element): number {
    if (!docEl) return -1;
    const wrap = from.closest(".wp-checklist");
    if (!wrap) return -1;
    return [...docEl.querySelectorAll(".wp-checklist")].indexOf(wrap);
  }

  function beginAddCriterion(btn: HTMLElement) {
    const wrap = btn.closest(".wp-checklist");
    const list = wrap?.querySelector(".wp-check-list") as HTMLElement | null;
    if (!list) return;
    const existing = list.querySelector(".wp-check--adding input") as
      | HTMLInputElement
      | null;
    if (existing) {
      existing.focus();
      return;
    }

    const li = document.createElement("li");
    li.className = "wp-check wp-check--adding";
    li.setAttribute("data-keep", "1");
    const box = document.createElement("span");
    box.className = "wp-check-box";
    box.innerHTML = CHECK_SVG;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "wp-check-input";
    input.placeholder = "New acceptance criterion…";
    li.append(box, input);
    list.appendChild(li);
    input.focus();

    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const val = input.value.trim();
      if (keep && val) {
        const label = document.createElement("span");
        label.className = "wp-check-label";
        label.textContent = val;
        li.classList.remove("wp-check--adding");
        li.removeAttribute("data-keep");
        li.setAttribute("data-raw", val);
        li.replaceChild(label, input);
        li.appendChild(makeDeleteBtn());
        queueMicrotask(() => settle());
        const ord = checklistOrd(li);
        if (!readOnly && ord >= 0) onAddCriterion({ ord, text: val });
      } else {
        li.remove();
        queueMicrotask(() => settle());
      }
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  /* ---------------- inline editing ---------------- *
   * Double-click any prose and a caret appears — no toolbar, no mode switch,
   * nothing else changes. Typing splices straight into the plan file on a short
   * debounce, the same fire-and-forget write-through the checkboxes use. The
   * document deliberately does NOT re-render while the caret is in a block:
   * the file watcher's echo would replace the DOM mid-keystroke.
   */
  const EDIT_DEBOUNCE = 400;

  /**
   * The only edits allowed to reach the document. Everything else — Cmd+B and
   * friends, Enter's paragraph split, an HTML drop — is refused here rather
   * than enumerated as keyboard shortcuts, so a rich-text editable behaves as
   * a plain-text one. Whatever the user types stays text, which is all the
   * source mapping in lib/srcmap.ts can write back.
   */
  const ALLOWED_INPUT = new Set([
    "insertText",
    "insertReplacementText",
    "insertCompositionText",
    "deleteContentBackward",
    "deleteContentForward",
    "deleteWordBackward",
    "deleteWordForward",
    "deleteSoftLineBackward",
    "deleteSoftLineForward",
    "deleteByCut",
    "historyUndo",
    "historyRedo",
  ]);

  type EditSession = {
    el: HTMLElement;
    start: number;
    end: number;
    /** The unit's rendered text as last written to the file. */
    before: string;
    /** The whole plan source as last written to the file. */
    src: string;
    /* One prose_edit event aggregates the whole session (see endEdit). */
    startedAtMs: number;
    sourceStart: number;
    insertedChars: number;
    removedChars: number;
    flushCount: number;
  };
  let edit: EditSession | null = null;
  let editTimer: ReturnType<typeof setTimeout> | undefined;

  /** Is this a unit a reviewer may type into? */
  function editableUnit(target: HTMLElement): HTMLElement | null {
    if (readOnly || !docEl) return null;
    // Deleted redline runs are a record of what the text used to say, not text.
    if (target.closest("del.wp-del")) return null;
    const unit = target.closest("[data-blk]") as HTMLElement | null;
    if (!unit || !docEl.contains(unit)) return null;
    // hljs and mermaid own their subtrees and rewrite them after every render,
    // so a caret in there would be swept away — and its source whitespace is
    // load-bearing besides.
    if (target.closest("figure.wp-code, figure.wp-mermaid, pre")) return null;
    return unit;
  }

  function beginEdit(unit: HTMLElement, caret: Range | null) {
    const range = blkRange(unit);
    if (!range) return;
    const raw = markdown.slice(range.start, range.end);
    const before = ownText(unit);
    // No usable mapping back to the source means no safe way to write the edit
    // back, so the unit simply stays read-only rather than guessing.
    if (!before || !alignTextToSource(before, raw)) return;

    edit = {
      el: unit,
      start: range.start,
      end: range.end,
      before,
      src: markdown,
      startedAtMs: Date.now(),
      sourceStart: range.start,
      insertedChars: 0,
      removedChars: 0,
      flushCount: 0,
    };
    // `true`, not `plaintext-only`: the latter puts Blink into a plaintext
    // editing mode that lays out the newlines already in the text as real line
    // breaks — focusing a block made the plan file's hard wraps visible and
    // re-flowed the paragraph, which no CSS override undoes. Plain text is
    // enforced at the input level instead (see ALLOWED_INPUT below).
    unit.setAttribute("contenteditable", "true");
    unit.focus({ preventScroll: true });
    // A caret, not a word selection: the double-click is the gesture that opens
    // editing, so it must not also select anything.
    if (caret) {
      caret.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(caret);
    }
    onEditing(true);
  }

  /** Write whatever changed since the last flush. */
  async function flushEdit(): Promise<void> {
    clearTimeout(editTimer);
    if (!edit) return;
    const session = edit;
    const raw = session.src.slice(session.start, session.end);
    const splice = spliceFromEdit(
      session.before,
      ownText(session.el),
      raw,
      session.start,
    );
    // Null covers "nothing changed" and "not safely writable yet" — a
    // half-deleted `code span` mid-keystroke, say. Leaving the file alone and
    // retrying on the next flush is right in both cases.
    if (!splice) return;

    // Comment anchors are absolute offsets into the rendered text, so they have
    // to move with the edit. Only the text *before* the unit matters here, and
    // typing inside the unit cannot change that — so this stays valid whether
    // it is measured before or after the keystrokes that triggered the flush.
    const docBase = docTextOffset(session.el);

    const res = await onEditText(splice);
    if (!edit || edit !== session) return; // the session ended while we waited
    if (!res.ok) {
      // An agent wrote underneath us. The file wins; drop out of editing and
      // let the re-render show what it actually says.
      endEdit(res.markdown);
      return;
    }
    session.src = res.markdown;
    session.end += splice.text.length - (splice.end - splice.start);
    session.before =
      session.before.slice(0, splice.textStart) +
      splice.text +
      session.before.slice(splice.textStart + splice.removed);
    session.insertedChars += splice.inserted;
    session.removedChars += splice.removed;
    session.flushCount += 1;
    if (docBase >= 0 && (splice.removed || splice.inserted)) {
      onTextShift({
        at: docBase + splice.textStart,
        removed: splice.removed,
        inserted: splice.inserted,
      });
    }
  }

  /** Offset of a unit's first character in the document's rendered text. */
  function docTextOffset(unit: Element): number {
    if (!docEl) return -1;
    const walker = textWalker(docEl);
    let pos = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (unit.contains(node)) return pos;
      pos += node.textContent?.length ?? 0;
    }
    return -1;
  }

  function endEdit(markdownOverride?: string): void | Promise<void> {
    const session = edit;
    if (!session) return;
    edit = null;
    clearTimeout(editTimer);
    session.el.removeAttribute("contenteditable");
    queueMicrotask(() => settle());
    // One aggregate event per edit session; sessions that changed nothing
    // (dblclick + click away) stay out of the log.
    if (session.insertedChars + session.removedChars > 0)
      onUiEvent({
        type: "prose_edit",
        sourceStart: session.sourceStart,
        insertedChars: session.insertedChars,
        removedChars: session.removedChars,
        flushCount: session.flushCount,
        durationMs: Math.max(0, Date.now() - session.startedAtMs),
      });
    // Hand the parent the text the file now holds so the document re-renders
    // with fresh source offsets (and, once there is a baseline, fresh redline).
    return onEditing(false, markdownOverride ?? session.src);
  }

  // The in-flight commit, so a double-click that lands while one is settling
  // waits for the re-render instead of resolving against a stale DOM. Blur and
  // double-click race on every click-into-another-block, so this ordering is
  // the common path, not an edge case.
  let committing: Promise<void> | null = null;

  function commitEdit(): Promise<void> {
    committing = (async () => {
      await flushEdit();
      await endEdit();
    })();
    return committing;
  }

  $effect(() => {
    const el = docEl;
    if (!el) return;

    // Blink selects the word on the *second* mousedown, before `dblclick` ever
    // fires — so by the time editing opens, a highlight is already painted and
    // reads as the gesture's result. Preventing that mousedown's default keeps
    // the double-click meaning one thing: open the editor. Selection is left to
    // dragging, which never reaches here (detail 1).
    //
    // Only where the gesture has an editing meaning to reserve: inside a code
    // block or a sealed version double-click can never open an editor, so
    // word-select stays useful there and is left alone. Same inside the block
    // already being edited, where the caret is up and double-click has no other
    // job than ordinary text selection.
    const onMouseDown = (e: MouseEvent) => {
      if (e.detail < 2) return;
      const target = e.target as HTMLElement | null;
      if (!target || edit?.el.contains(target)) return;
      if (!editableUnit(target)) return;
      e.preventDefault();
    };

    const onDblClick = async (e: MouseEvent) => {
      if (readOnly) return;
      if (edit?.el.contains(e.target as Node)) return; // already editing here
      const { clientX: x, clientY: y } = e;
      if (edit) commitEdit();
      if (committing) {
        // Finish writing the previous block and let its re-render land, then
        // resolve the click against the DOM that actually exists now.
        await committing;
        await tick();
      }
      const caret =
        (document as any).caretRangeFromPoint?.(x, y) ?? null;
      const from = caret?.startContainer ?? (e.target as Node);
      const el = (
        from.nodeType === 1 ? from : from.parentElement
      ) as HTMLElement | null;
      const unit = el && editableUnit(el);
      if (unit) beginEdit(unit, caret);
    };

    const onBeforeInput = (e: InputEvent) => {
      if (!edit || !edit.el.contains(e.target as Node)) return;
      if (!ALLOWED_INPUT.has(e.inputType)) e.preventDefault();
    };

    const onInput = (e: Event) => {
      if (!edit || !edit.el.contains(e.target as Node)) return;
      clearTimeout(editTimer);
      editTimer = setTimeout(() => void flushEdit(), EDIT_DEBOUNCE);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!edit) return;
      // A newline would break the line-oriented grammar every other reader of
      // this file depends on (`- [ ]` criteria, `## Phase N` headings), so
      // Enter finishes the edit instead of splitting the block.
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        void commitEdit();
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      if (!edit) return;
      e.preventDefault();
      const text = (e.clipboardData?.getData("text/plain") ?? "").replace(
        /[\r\n]+/g,
        " ",
      );
      if (text) document.execCommand("insertText", false, text);
    };

    const onFocusOut = (e: FocusEvent) => {
      if (!edit) return;
      const next = e.relatedTarget as Node | null;
      if (next && edit.el.contains(next)) return;
      void commitEdit();
    };

    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("dblclick", onDblClick);
    el.addEventListener("beforeinput", onBeforeInput as EventListener);
    el.addEventListener("input", onInput);
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("paste", onPaste);
    el.addEventListener("focusout", onFocusOut);
    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("dblclick", onDblClick);
      el.removeEventListener("beforeinput", onBeforeInput as EventListener);
      el.removeEventListener("input", onInput);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("paste", onPaste);
      el.removeEventListener("focusout", onFocusOut);
    };
  });

  $effect(() => {
    const el = docEl;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // A resolved file reference opens the file beside the plan. Checked
      // first: refs live inside prose that is otherwise click-to-select.
      // …except inside a block being edited, where a click must place the
      // caret; the reviewer is writing, not navigating.
      const ref = target.closest?.("code.wp-ref.is-linked") as HTMLElement | null;
      if (ref && el.contains(ref) && !ref.closest('[contenteditable="true"]')) {
        e.preventDefault();
        const line = Number(ref.getAttribute("data-line"));
        onOpenRef(
          ref.getAttribute("data-path")!,
          Number.isInteger(line) && line > 0 ? line : undefined,
        );
        return;
      }
      // Callout entry actions (reject / comment).
      if (
        handleCalloutClick(e, el, {
          onVerdict: (d) => onVerdict(d),
          onComment: (a) => beginCalloutComment(a),
        })
      ) {
        e.preventDefault();
        return;
      }
      // Remove a criterion (× button) — persisted to the plan file.
      const delBtn = target.closest?.(".wp-check-del") as HTMLElement | null;
      if (delBtn && el.contains(delBtn)) {
        e.preventDefault();
        const row = delBtn.closest(".wp-check") as HTMLElement | null;
        if (row) {
          const raw = row.getAttribute("data-raw") ?? "";
          const ord = checklistOrd(row);
          row.remove();
          if (!readOnly && raw && ord >= 0) onRemoveCriterion({ ord, text: raw });
        }
        queueMicrotask(() => settle());
        return;
      }
      const addBtn = target.closest?.(".wp-check-add") as HTMLElement | null;
      if (addBtn && el.contains(addBtn)) {
        e.preventDefault();
        beginAddCriterion(addBtn);
        return;
      }
      // The box is the whole hit target: clicking the criterion's text leaves
      // it alone, which is what frees a double-click there to mean "edit".
      const box = target.closest?.(".wp-check-box") as HTMLElement | null;
      const li = box?.closest(".wp-check") as HTMLElement | null;
      // Don't toggle the in-progress "add criterion" row.
      if (li && el.contains(li) && !li.classList.contains("wp-check--adding")) {
        const checked = li.classList.toggle("is-checked");
        // Any reviewer tick persists — for `@human` items this is the
        // resolution mechanism the implement skill waits on.
        if (!readOnly) {
          const raw = li.getAttribute("data-raw") ?? "";
          const ord = checklistOrd(li);
          if (raw && ord >= 0) onSetCriterion({ ord, text: raw, checked });
        }
      }
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  });

  // A plan/version switch re-keys the section ordinals, so the accumulated
  // dwell flushes against the outgoing document before the new one builds.
  let dwellDoc = "";
  $effect(() => {
    if (markdown !== dwellDoc) {
      dwellDoc = markdown;
      dwell.flush();
    }
  });

  /* ---------------- lifecycle ---------------- */
  $effect(() => {
    const onEngagement = () =>
      dwell.setEngaged(document.hasFocus() && !document.hidden);
    const onPageHide = () => dwell.flush();
    const onResize = () => updateDwellSection();
    document.addEventListener("mouseup", onMouseUp);
    window.addEventListener("resize", settle);
    window.addEventListener("resize", onResize);
    window.addEventListener("focus", onEngagement);
    window.addEventListener("blur", onEngagement);
    document.addEventListener("visibilitychange", onEngagement);
    window.addEventListener("pagehide", onPageHide);
    onEngagement();
    if ((document as any).fonts?.ready) {
      (document as any).fonts.ready.then(() => settle());
    }
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("resize", settle);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("focus", onEngagement);
      window.removeEventListener("blur", onEngagement);
      document.removeEventListener("visibilitychange", onEngagement);
      window.removeEventListener("pagehide", onPageHide);
      dwell.destroy();
      if (settleT) clearTimeout(settleT);
    };
  });
  /** Reading position, for carrying the reader across a plan/redline swap. */
  export const anchor = (): ReadingAnchor | null => readingAnchor(mainEl, docEl);
  export const restore = (a: ReadingAnchor | null) => restoreReading(a, mainEl, docEl);
</script>

<main
  class="relative flex-1 overflow-auto bg-surface-page outline-none focus:outline-none focus-visible:outline-none"
  bind:this={mainEl}
  onscroll={onScroll}
>
  {#if loading}
    <p class="px-6 py-11 text-sm text-muted">Loading…</p>
  {:else if html}
    <div
      class="relative ml-4 max-w-[calc(100%-32px)] pb-[60vh] pt-10"
      bind:this={contentEl}
      style="width:{artW}px;"
    >
      <div
        class="wp-prose wp-doc-card max-w-full"
        class:is-regenerating={dimmed}
        bind:this={docEl}
        data-plan-theme={theme}
      >
        {@html html}
      </div>

      <!-- Card resize: the left edge is pinned, so only the right border drags. -->
      <div
        class="{handleCls} right-[-5px]"
        data-keep="1"
        role="presentation"
        onpointerdown={startDrag}
        onpointermove={dragMove}
        onpointerup={endDrag}
        onpointercancel={endDrag}
        ondblclick={resetWidth}
      ></div>

      <!-- Floating comment margin -->
      {#each allCards as c (c.id)}
        {@const active = activeId === c.id}
        <div
          class="ease-standard absolute cursor-pointer rounded-sm bg-surface-quiet px-3 py-2.5 transition-[opacity,box-shadow] duration-[140ms] {active
            ? 'shadow-[inset_0_0_0_1.5px_var(--border-strong)]'
            : ''}"
          data-card={c.id}
          data-keep="1"
          bind:this={cardRefs[c.id]}
          style="left:{comLeft}px; width:{COM_W}px; top:{positions[c.id] ?? 0}px;
            opacity:{positions[c.id] != null ? 1 : 0};
            z-index:{active ? 6 : 2};"
          onclick={(e) => {
            e.stopPropagation();
            if (!(c as any).composing) onActivate(c.id);
          }}
          role="presentation"
        >
          {#if (c as any).composing}
            <!-- svelte-ignore a11y_autofocus -->
            <textarea
              class="min-h-14 w-full resize-none rounded-sm border-0 bg-surface-page px-2 py-1.5 font-display text-[13px] leading-normal text-strong shadow-hairline outline-none"
              autofocus
              bind:value={composeBody}
              placeholder="Add a comment…"
              onclick={(e) => e.stopPropagation()}
              onkeydown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelDraft();
                } else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitDraft();
                }
              }}
            ></textarea>
            <div class="mt-2 flex items-center justify-between gap-1.5">
              <label
                class="inline-flex cursor-pointer select-none items-center gap-1.5 font-sans text-[10px] {composeCross
                  ? 'font-semibold text-wp-indigo-600'
                  : 'text-subtle'}"
                title="Ask for a whole-plan revision pass, not a local edit"
                onclick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  class="h-3 w-3 accent-[var(--color-indigo-600)]"
                  bind:checked={composeCross}
                />
                Cross-cutting
              </label>
              <span class="flex gap-1.5">
                <Button variant="ghost" size="sm" onclick={cancelDraft}>Cancel</Button>
                <Button variant="primary" size="sm" onclick={submitDraft}>Comment</Button>
              </span>
            </div>
          {:else}
            <p
              class="m-0 whitespace-pre-wrap font-display text-[13px] leading-normal {(c as any)
                .resolved || (c as any).stale
                ? 'text-muted'
                : 'text-strong'}"
            >
              {c.body}
            </p>
            <div class="mt-2 flex items-center justify-between gap-2">
              <span class="font-sans text-[10px] text-subtle">{relativeTime(c.createdAt)}</span>
              {#if (c as any).resolved}
                <span class="font-sans text-[10px] font-semibold tracking-[0.02em] text-wp-indigo-600">
                  Resolved
                </span>
              {:else if (c as any).stale}
                <!-- The quoted text was edited underneath this comment. Kept,
                     not dropped: the reviewer decides whether it still applies. -->
                <span
                  class="font-sans text-[10px] font-semibold tracking-[0.02em] text-subtle"
                  title="The text this comment quoted has since been edited"
                >
                  Edited since
                </span>
              {:else if active && !readOnly}
                <button
                  type="button"
                  class="cursor-pointer border-0 bg-transparent p-0 font-sans text-[10px] tracking-[0.02em] text-subtle hover:text-wp-orange-500"
                  onclick={(e) => {
                    e.stopPropagation();
                    onDelete(c.id);
                  }}>Delete</button
                >
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <p class="px-6 py-11 text-sm text-muted">Select a plan to view it.</p>
  {/if}
</main>

<!-- Selection toolbar -->
{#if toolbar.visible}
  <div
    class="animate-wp-scale fixed z-[60]"
    style="left:{toolbar.x}px; top:{toolbar.y}px;"
    onmousedown={(e) => e.preventDefault()}
    role="presentation"
  >
    <button
      type="button"
      class="inline-flex cursor-pointer items-center gap-1.5 rounded-sm border-0 bg-surface-card px-3 py-[7px] font-display text-xs font-semibold text-body shadow-hairline hover:bg-wp-gray-100"
      onclick={createDraft}
    >
      <Icon name="comment" size={15} />
      Comment
    </button>
  </div>
{/if}

<!-- Outline rail -->
{#if OUTLINE_RAIL && headings.length > 1}
  <nav
    class="ease-standard fixed right-4 top-1/2 z-30 flex -translate-y-1/2 flex-col items-end gap-[7px] rounded-md px-2.5 py-2 transition-[background,box-shadow] duration-[120ms] hover:bg-surface-card hover:shadow-[var(--ring-hairline),var(--shadow-pop)]"
    onmouseenter={() => (navHover = true)}
    onmouseleave={() => (navHover = false)}
    aria-label="Plan outline"
  >
    {#each headings as h, hi (h.id)}
      {@const a = activeSection === h.id}
      <button
        type="button"
        class="inline-flex h-[18px] cursor-pointer items-center justify-end gap-[11px] border-0 bg-transparent p-0"
        onclick={() => {
          scrollToSection(h.id);
          onUiEvent({ type: "nav_jump", source: "outline", targetIndex: hi });
        }}
      >
        {#if navHover}
          <span
            class="whitespace-nowrap font-sans text-[9px] font-medium uppercase tracking-[0.08em] {a
              ? 'font-bold text-wp-green-700'
              : 'text-subtle'}"
          >
            {h.label}
          </span>
        {/if}
        <span
          class="h-[7px] w-[7px] shrink-0 rounded-full {a
            ? 'bg-wp-green-700'
            : 'bg-wp-gray-300'}"
        ></span>
      </button>
    {/each}
  </nav>
{/if}
