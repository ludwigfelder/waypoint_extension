# Legible diagrams, one per phase where they earn it

## Context

Depth: Standard

Two problems, one about the viewer and one about the planner. In the viewer, a
diagram wider than the plan card is scaled down to fit, so its labels render at
roughly half the size of the surrounding body text — the screenshot's seven-node
`flowchart LR` is the normal case, not an outlier. Mermaid ships the SVG at
`width="100%"` with `style="max-width:<natural>px"`, and `.wp-mermaid-out svg`
adds `max-w-full`; together they mean *fit the column, whatever that costs the
type*. In the skill, the Mermaid bullet reads "Use **one** ONLY when a diagram
conveys structure the prose cannot", which plans have been reading as one
diagram per plan — so the whole change gets a topology sketch up front and the
phases that actually introduce new flow get nothing.

The outcome: diagram text is never smaller than the prose around it, wide
diagrams scroll instead of shrinking, and a phase that introduces structure
carries its own diagram.

## Out of scope

The plan card's own geometry — `CARD_MIN_W`/`CARD_MAX_W` stay 560/920
(`src/webview/lib/layout.ts`). No zoom or pan affordance of any kind: no
scroll-wheel zoom, no drag-pan, and — after the Phase 2 reversal — no
click-to-open overlay either. Legibility comes from the floor and from scroll,
nothing else. No change to which Mermaid diagram types are supported, and no
change to the other three waypoint skills.

:::assumption #A1 verified:code
Mermaid renders every diagram with `useMaxWidth` defaulting to true, which sets
`width="100%"` and `style="max-width:<natural>px"`
(`calculateSvgSizeAttrs`, `node_modules/mermaid/dist/chunks/mermaid.core/chunk-WYO6CB5R.mjs`).
With `.wp-mermaid-out svg { max-w-full }` (`src/webview/app.css:671`) a diagram
wider than the ~680px prose column is downscaled by its viewBox — that scaling,
not a font setting, is why the labels are small.
:::

:::assumption #A2 verified:code
Comment anchors are character offsets over *every* Text node under the document
element, including the `<text>` nodes Mermaid injects into the SVG
(`offsetsFromSelection` / `rangeFromOffsets`, `src/webview/lib/anchor.ts`); the
`mermaidTick` counter at `src/webview/components/PlanDocument.svelte:162` exists
precisely to re-anchor after a diagram renders. Consequence: any zoom affordance
that adds text inside the card, or that clones the SVG into the card, silently
shifts every comment anchored after that diagram.
:::

:::assumption #A3 verified:code revised(v2)
A diagram cannot be widened past the card. The card is `artW` px wide and
left-aligned, and comment cards are absolutely positioned at `artW + GAP`
(`src/webview/components/PlanDocument.svelte:70`, `:714`), so bleeding a figure
rightward would land under the comment gutter. Legibility has to come from the
scale floor and from scroll, not from extra inline width — originally "scroll
and overlay", but the overlay was cut in Phase 2 and the floor proved
sufficient on its own.
:::

:::assumption #A4 verified:code
Mermaid sets a `viewBox` on the rendered SVG for every diagram it lays out
(`setupGraphViewbox`, same chunk as #A1), so natural width is readable from
`svg.viewBox.baseVal.width` without knowing the diagram type. Consequence if
false for some type: that type falls back to parsing `style.max-width`, which
#A1 shows is also always set.
:::

:::assumption #A5 verified:code
The waypoint skill exists as two hand-maintained, byte-identical sources —
`.claude/skills/waypoint/SKILL.md` and `.agents/skills/waypoint/SKILL.md` —
and `resources/kit/**` is *generated* from them by `copyKit()` (`build.ts:51`).
No test asserts the two sources stay in sync. Consequence: editing one and not
the other ships the new guidance to Claude users and not Codex users, with
nothing failing to say so.
:::

:::assumption #A6 verified:probe(C1)
A single fit rule can serve every diagram type: shrink to fit only while the
scale stays at or above a legibility floor, otherwise hold the floor and let the
figure scroll. 0.85 is the proposed floor — at an 18px base that is ~15px
rendered, still above the 14px body text.
:::

:::assumption #A7 asserted
Raising Mermaid's base font to 18px is a net win rather than a wash. It is only
a win *because* of the floor rule: under the old fit-to-column behaviour a
bigger font grows the natural width proportionally and the extra size is
scaled straight back off. Consequence if the diagrams then feel too wide:
`DIAGRAM_FONT_PX` and the flowchart spacing constants are one-line tunables,
checked by #C4.
:::

:::boundary
Consulted: `src/webview/components/PlanDocument.svelte` (mermaid effect, card
geometry, comment positioning), `src/webview/lib/{markdown,anchor,layout}.ts`,
`src/webview/app.css`, `build.ts`, the existing `tests/`, the four skill
sources, and Mermaid 11's sizing internals in `node_modules`. Not reached:
nothing was rendered — every legibility claim here is untested by construction,
which is what the `diagram-test-plan` fixture and the `@human` criteria are
for. How the SVG reflows at the 560px minimum card width is unmeasured, as is
whether Mermaid's dark theme at 18px keeps enough contrast on edge labels.
:::

## Phase 1: Size diagrams to read — floor, scroll, bigger type

The fix is a sizing pass that runs after each `mermaid.render`, replacing
Mermaid's fit-the-container sizing with our own. The pure part goes in a new
`src/webview/lib/diagram.ts` so it is unit-testable without a DOM: `fitDiagram(naturalW, colW)`
returns the width to apply and whether the figure must scroll. Three cases —
the diagram already fits (render at natural size, centred); it overflows but
scaling to fit stays at or above the floor (fit, mild shrink); it overflows
past the floor (hold the floor width and scroll).

The DOM part lives in the existing mermaid `$effect` in
`src/webview/components/PlanDocument.svelte:163`. After `out.innerHTML = svg`,
read natural width from `viewBox` (#A4), call `fitDiagram` against
`out.clientWidth`, then set the SVG's inline `width` and `max-width:none` —
inline style beats Mermaid's `width="100%"` presentation attribute, so nothing
has to be removed. Toggle a `wp-mermaid-scroll` class on the `<figure>` for the
scrolling case. `mermaidTick` must be bumped *after* sizing, not after
rendering, or comments re-anchor against a width that is about to change (#A2).

Card resize has to re-fit too: a second effect reads `artW` and re-runs the
sizing pass over already-rendered SVGs — no Mermaid re-render — then bumps
`mermaidTick`.

Typography and spacing move in the same `mermaid.initialize` call: an 18px base
via `themeVariables.fontSize`, the document's own font family for continuity,
and tightened flowchart spacing so the bigger type does not add more width than
it has to.

:::decision #D1
Override Mermaid's sizing after the fact instead of configuring
`useMaxWidth: false`. Rationale: `useMaxWidth` is per-diagram-type config —
`flowchart`, `sequence`, `state`, `er`, `gantt`, … each carry their own — so
disabling it means enumerating types and revisiting the list whenever a plan
uses a new one. Reading `viewBox` (#A4) is type-agnostic and keeps the fit rule
in one testable function. Rejected: setting `useMaxWidth: false` per type — a
list that silently goes stale.
:::

:::decision #D2
The legibility floor is a *floor*, not a ban on shrinking. A diagram 5% too
wide fits with a shrink no one can see; forcing it to scroll would be worse
than the problem. Rejected: never downscale at all (scroll the moment natural
width exceeds the column) — simpler, but it makes marginal diagrams scroll for
nothing.
:::

This phase also creates the fixture every visual check in this plan runs
against: `.waypoint/plans/diagram-test-plan.md`, a plan whose phases each carry
a diagram chosen to stress a different width regime — comfortably narrow, a
borderline case just inside the floor, a wide `LR` chain like the screenshot's,
plus sequence, state, and a ~12-node graph. It is a fixture, not a sample: its
job is to fail visibly when sizing regresses.

:::collapse Phase 1 edits | new lib + effect changes + CSS
**New `src/webview/lib/diagram.ts`**

```ts src/webview/lib/diagram.ts
// Diagram sizing. Mermaid fits the container at any cost to legibility; we
// instead hold a minimum scale and let wide diagrams scroll (the treatment
// wide tables already get in .wp-prose table).

/** Never render a diagram below this fraction of its natural size. */
export const MIN_SCALE = 0.85;
/** Mermaid base font. Bigger than the 14px body text on purpose. */
export const DIAGRAM_FONT_PX = 18;

export type DiagramFit = { width: number; scroll: boolean };

export function fitDiagram(naturalW: number, colW: number): DiagramFit {
  if (!(naturalW > 0) || !(colW > 0)) return { width: colW, scroll: false };
  if (naturalW <= colW) return { width: naturalW, scroll: false };
  if (colW / naturalW >= MIN_SCALE) return { width: colW, scroll: false };
  return { width: Math.round(naturalW * MIN_SCALE), scroll: true };
}
```

**`src/webview/components/PlanDocument.svelte`** — in the mermaid effect,
after `out.innerHTML = svg`:

```ts
sizeDiagram(fig as HTMLElement);
mermaidTick++;   // after sizing, not after render
```

with the helper alongside the effect:

```ts
function sizeDiagram(fig: HTMLElement): void {
  const out = fig.querySelector(".wp-mermaid-out") as HTMLElement | null;
  const svg = out?.querySelector("svg") as SVGSVGElement | null;
  if (!out || !svg) return;
  const natural =
    svg.viewBox?.baseVal?.width ||
    parseFloat(svg.style.maxWidth) ||
    0;
  const fit = fitDiagram(natural, out.clientWidth);
  svg.style.maxWidth = "none";
  svg.style.width = `${fit.width}px`;
  svg.style.height = "auto";
  fig.classList.toggle("wp-mermaid-scroll", fit.scroll);
}
```

and a re-fit on card resize:

```ts
$effect(() => {
  void artW;              // card drag reflows the column
  void mermaidTick;       // and run once diagrams exist
  if (!docEl) return;
  for (const fig of docEl.querySelectorAll(".wp-mermaid"))
    sizeDiagram(fig as HTMLElement);
});
```

Guard the re-fit effect against re-entrancy: it reads `mermaidTick` but must
not bump it, or it loops.

**`mermaid.initialize`** in the same effect gains:

```ts
themeVariables: {
  fontFamily: getComputedStyle(docEl).fontFamily,
  fontSize: `${DIAGRAM_FONT_PX}px`,
},
flowchart: { padding: 10, nodeSpacing: 36, rankSpacing: 44 },
```

**`src/webview/app.css`** (around the existing block at `:656`):

```css
  .wp-prose .wp-mermaid-out {
    @apply w-full select-none overflow-x-auto;
  }
  .wp-prose .wp-mermaid-out svg {
    @apply mx-auto block h-auto;
  }
  /* A scrolling figure must not be centred: `text-align:center` on an
     overflowing scroll container clips the left edge instead of the right. */
  .wp-prose .wp-mermaid-scroll {
    @apply text-left;
  }
  .wp-prose .wp-mermaid-scroll .wp-mermaid-out svg {
    @apply mx-0;
  }
```

Drop `max-w-full` from the svg rule — the inline width from `sizeDiagram` is
now authoritative.

**`tests/diagram.test.ts`** covers: exact fit; natural narrower than column;
overflow inside the floor (returns `colW`, no scroll); overflow past the floor
(returns `naturalW * MIN_SCALE`, scrolls); zero/NaN inputs.

**`tests/diagramFixture.test.ts`** renders `.waypoint/plans/diagram-test-plan.md`
through `renderMarkdown` and asserts at least six `class="wp-mermaid"` figures
survive — the fixture cannot silently lose its diagrams.
:::

### Phase 1 acceptance gate

:::checklist
- [x] #C1 `bun test tests/diagram.test.ts` exits 0, covering all four `fitDiagram` branches plus degenerate input.
  evidence: bun test tests/diagram.test.ts exited 0 (6 pass)
- [x] #C2 `bun test tests/diagramFixture.test.ts` exits 0 — the fixture renders with at least six mermaid figures.
  evidence: bun test tests/diagramFixture.test.ts exited 0 (6 mermaid figures in diagram-test-plan.md)
- [x] #C3 `bun run build` exits 0 and prints its `built:` line.
  evidence: bun run build exited 0: 'built: out/extension.js, media/webview.js, media/webview.css, media/hljs-*.css, resources/kit/'
- [x] #C4 @human With `.waypoint/plans/diagram-test-plan.md` open in the viewer: every diagram's label text is at least as large as the body text next to it, the wide `LR` diagram scrolls horizontally instead of shrinking, and no diagram is clipped at its left edge.
- [x] #C5 @human Drag the card from 560px to 920px and back: diagrams re-fit without a reload, and comment cards beside a diagram stay level with their highlights.
:::

:::runrecord
- deviation: `sizeDiagram(fig)` runs inside the render `try`, not between it and
  `mermaidTick++` as the snippet showed — the plan's placement would have sized
  a figure whose `out.innerHTML` is an error `<pre>`. `mermaidTick++` still runs
  once per figure after both paths, as #A2 requires.
- decided: the error path also clears `wp-mermaid-scroll`. A figure that
  scrolled on a previous render and then fails to parse (theme toggle, edited
  source) would otherwise keep a left-aligned scroll box around its error text.
- decided: the `diagram-test-plan` fixture's own gates are all `@human` — it is
  a visual fixture, so there is nothing in it an agent can check. The
  agent-checkable half of the fixture is `tests/diagramFixture.test.ts`, which
  asserts the six figures and their sources survive rendering.
:::

## Phase 2: Click a diagram to open it full-panel — built, then cut

**Built, then cut.** This phase shipped a working click-to-zoom overlay —
`DiagramZoom.svelte`, a click target on `.wp-mermaid-out`, Escape/backdrop
dismissal — and the reviewer, seeing Phase 1 rendered in the viewer, judged
diagrams already legible at rest and removed it. The phase is kept here as the
record of that round trip, not as work to do. Nothing in it should be
reimplemented.

Its premise was that "even at the floor, a twelve-node graph is a scroll box in
a 680px column", so an escape hatch to natural size against the whole panel was
worth a new component. What the rendered result showed is that Phase 1's floor
plus the 18px base font already put every diagram in `diagram-test-plan` above
the body-text size — the scroll box is legible, and a second way to view the
same diagram was cost without benefit.

:::decision #D3 revised(v2)
~~Re-render the diagram with a distinct id for the overlay
(`mermaid.render("wp-mmd-zoom", src)`) instead of `cloneNode(true)`.~~ Moot:
there is no overlay. The reasoning was sound and is worth keeping against a
future zoom affordance — Mermaid embeds a `<style>` block inside each SVG scoped
by that SVG's own id, so a clone either duplicates the id (two elements
answering `#wp-mmd-3`) or needs its id and every selector in its inline
stylesheet rewritten. Anything that shows a second copy of a rendered diagram
must re-render rather than clone.
:::

The one piece of Phase 2 that survives is `diagramMermaidConfig(theme,
fontFamily)` in `src/webview/lib/diagram.ts`. It was extracted so the overlay
and the inline renderer could not drift apart — Mermaid's config is a module
singleton, so a second initializer that set theme alone would have silently
dropped Phase 1's 18px font. With the overlay gone it has one caller, but it
keeps that config unit-testable instead of buried in an `$effect`.

### Phase 2 acceptance gate

:::checklist
- [x] #C6 `bun test` exits 0 — the full suite, confirming no anchor/markdown regressions from the overlay wiring.
  evidence: bun test exited 0 — 134 pass, 0 fail across 13 files
- [x] #C7 `bun run build` exits 0.
  evidence: bun run build exited 0; 'wp-mmd-zoom' present in media/webview.js (overlay bundled)
:::

`#C8` and `#C9` were the overlay's two `@human` checks — clicking each diagram
opens it full-panel, and comment anchors survive an open/close cycle (#A2).
Both describe behaviour that no longer exists; they are removed rather than
left unticked, and their IDs are retired.

:::runrecord
- decided: the `mermaid.initialize` config moved into a shared
  `diagramMermaidConfig(theme, fontFamily)` in `src/webview/lib/diagram.ts`,
  used by both the inline effect and the overlay. Mermaid's config is a module
  singleton, so an overlay that re-initialized with theme alone would have
  dropped the 18px font out from under the inline diagrams on their next
  render. Covered by two new cases in `tests/diagram.test.ts`.
- deviation: the overlay sizes against `innerWidth * 0.92 - 40` rather than a
  flat 92vw — the panel's `p-5` padding is inside that 92vw box, so the plan's
  figure would have overflowed a diagram sized to exactly fill it.
- decided: the render-failure path also clears `cursor: zoom-in` and the click
  handler. A diagram whose source stops parsing should not stay clickable into
  an overlay that can only show the same error again.
- decided: the overlay panel carries `tabindex="-1"` — Svelte's a11y check
  requires a focusable element for `role="dialog"`, and unlike `ReplanModal`
  this dialog has no focusable children. Attribute only, no added text, so #A2
  is unaffected.
- deviation: `<svelte:window onkeydown>` rather than the plan's "keydown
  listener on `window`" — same effect, and it matches how `Header.svelte`
  already does it in this codebase.
- reversed: the reviewer, seeing Phase 1 in the viewer, judged diagrams already
  legible at rest and cut the zoom affordance. `DiagramZoom.svelte` is deleted
  and the click trigger, `zoomSrc` state, and `ZOOM_VIEWPORT_FRAC` are gone —
  no diagram is clickable. `diagramMermaidConfig` stays: it is now only the
  inline renderer's config, but it keeps that config testable. Phase 2's whole
  premise ("even at the floor, a twelve-node graph is a scroll box") did not
  survive contact with the rendered result, so #C8 and #C9 describe behaviour
  that no longer exists and cannot be checked.
:::

## Phase 3: Teach the skill that diagrams are per-phase

The guidance change is small and precise. Two edits, in both skill sources
(#A5) — `.claude/skills/waypoint/SKILL.md` and `.agents/skills/waypoint/SKILL.md`,
which must stay byte-identical; `resources/kit/**` is regenerated by
`bun run build` and is never edited by hand.

**What the skill says today.** One place mentions diagrams at all: the Mermaid
entry in the Plan Format list (`SKILL.md:303`). Its second sentence is the
whole problem —

> Use one ONLY when a diagram conveys structure the prose cannot […]

Read in a document that is otherwise organized per phase, "use one" scans as a
budget of one *per plan*. The Phase 4 per-phase bullet list (`SKILL.md:145`),
which tells the planner what each phase should contain — body, `:::decision`
callouts, `:::collapse` detail, acceptance gate — never mentions diagrams, so
nothing pulls the other way. The observed result is the failure this plan
opened with: a topology sketch at the top of the plan, and phases that
introduce genuinely new flow carrying nothing.

**What it says after.** Two edits, no new rule (#D4):

1. The per-phase bullet list gains a diagram bullet, sitting alongside the
   decision and collapse bullets, so the planner is asked the question once per
   phase instead of once per plan — and is told the answer is usually no.
2. The Mermaid entry drops "use one", states outright that diagrams belong to
   phases, and keeps the anti-decoration clause that made the original right.
   Its size advice is retuned to what the viewer now does: a wide diagram
   scrolls at the legibility floor rather than shrinking below the body text,
   so width no longer wrecks a diagram — but scrolling is still worse than not
   scrolling, so the shape advice (`TD` over `LR` past ~4 nodes, short labels,
   ~12 nodes) becomes a preference rather than a hard constraint. The `end` and
   leading-`o`/`x` syntax caveats are untouched.

Note the retuning is *scroll only*. An earlier draft of this phase promised
"wide diagrams scroll and zoom"; the zoom affordance was cut in Phase 2, and
the guidance must not advertise an escape hatch the viewer does not have.

:::collapse Phase 3 edits | the two hunks, before and after
Applied identically to `.claude/skills/waypoint/SKILL.md` and
`.agents/skills/waypoint/SKILL.md`.

**Hunk 1 — the per-phase bullet list (`SKILL.md:154`).** Insert after the
`:::collapse` bullet, before the `### Phase N acceptance gate` bullet:

````md
  - a `mermaid` diagram when — and only when — the phase introduces or changes
    structure the prose cannot carry: a new data flow, component wiring, a
    state machine. Most phases do not, and a diagram per phase is as wrong as
    one diagram per plan; see the Mermaid entry in the Plan Format section;
````

**Hunk 2 — the Mermaid entry (`SKILL.md:303`).** Before:

````md
- **Mermaid diagram**: a fenced block with language `mermaid` renders as an SVG
  in the viewer. Use one ONLY when a diagram conveys structure the prose cannot
  — a new or changed data flow, a component/dependency graph, a state machine —
  never as decoration or a restatement of a bullet list. Prefer
  `flowchart`/`graph`, and keep it small (roughly ≤ 12 nodes) so it reads at the
  document width. Two syntax caveats: never use a bare lowercase `end` as a node
  label (write `End`); if an edge target starts with `o` or `x`, add a leading
  space (`a --- ops`, not `a---ops`). Example:
````

After:

````md
- **Mermaid diagram**: a fenced block with language `mermaid` renders as an SVG
  in the viewer. Diagrams belong to **phases**, not to plans: a phase may carry
  one when it conveys structure the prose cannot — a new or changed data flow, a
  component/dependency graph, a state machine — and most phases carry none.
  Never decoration, never a restatement of a bullet list. Prefer
  `flowchart`/`graph`. The viewer holds diagram type at or above the body-text
  size and scrolls anything wider, so width no longer costs legibility — but a
  diagram that fits reads better than one that scrolls: prefer `flowchart TD`
  over `LR` for chains past about four nodes, keep node labels to a few words,
  and stay near ≤ 12 nodes. Two syntax caveats: never use a bare lowercase `end`
  as a node label (write `End`); if an edge target starts with `o` or `x`, add a
  leading space (`a --- ops`, not `a---ops`). Example:
````

The fenced `mermaid` example that follows the entry is unchanged.
:::

:::decision #D4
Fix the phrasing in the skill rather than adding a per-phase diagram *rule*.
Rationale: a rule ("give each phase a diagram") reintroduces the decoration the
existing guidance rightly forbids, just distributed. What was actually wrong was
one word — "one" reading as one-per-plan — so the edit removes the false budget
and moves the decision to the phase level, where the skill already puts
decisions and collapses. Rejected: a checklist criterion in the skill requiring
diagram coverage per phase, which would make plans worse to satisfy a count.
:::

:::note
`.waypoint/plans/sample-mermaid-showcase.md` already demonstrates one diagram
per phase across three diagram types. It stays as-is — it is a content sample,
distinct from Phase 1's `diagram-test-plan` fixture, which exists to stress
sizing.
:::

### Phase 3 acceptance gate

:::checklist
- [x] #C10 `diff -q .claude/skills/waypoint/SKILL.md .agents/skills/waypoint/SKILL.md` exits 0 — both sources carry the edit.
  evidence: diff -q .claude/skills/waypoint/SKILL.md .agents/skills/waypoint/SKILL.md exited 0
- [x] #C11 `bun run build && diff -q .claude/skills/waypoint/SKILL.md resources/kit/claude/skills/waypoint/SKILL.md && diff -q .agents/skills/waypoint/SKILL.md resources/kit/agents/skills/waypoint/SKILL.md` exits 0 — the bundled kit carries it too.
  evidence: bun run build && diff -q against resources/kit/claude/... and resources/kit/agents/... exited 0
- [x] #C12 `bun test tests/skillsKit.test.ts` exits 0.
  evidence: bun test tests/skillsKit.test.ts exited 0 (8 pass)
- [ ] #C13 @human Read the revised Mermaid bullet and the new phase bullet: they say diagrams belong to phases that earn them, and they still forbid decorative diagrams.
:::

:::runrecord
- discovered(A5): the two skill sources are not "two hand-maintained,
  byte-identical sources" — they are one file with two paths.
  `.claude/skills/waypoint/SKILL.md` and `.agents/skills/waypoint/SKILL.md`
  share inode 60737754, and the same holds for all four waypoint skills. Both
  hunks were written once and appeared in both paths; #C10 passed without a
  second edit. The consequence #A5 warned about (editing one and shipping
  guidance to Claude users but not Codex users) cannot happen while the
  hardlinks hold — but nothing in the repo records or enforces them, so a
  checkout, a copy, or an editor that writes-then-renames would silently break
  the link and restore exactly the drift #A5 described. Worth a follow-up:
  either a test asserting the two paths match, or a note in `CLAUDE.md`.
- corrected: the bullet above is wrong about the mechanism and therefore wrong
  about the risk. It is not a hardlink — `.claude/skills` is a **symlink** to
  `../.agents/skills`, and git tracks it as one (mode 120000, blob 2b7a412).
  The single-source arrangement is committed, so it survives clone and
  checkout; the drift #A5 warns about cannot occur, and no follow-up test is
  needed. The observation that both paths took the edit at once stands — the
  reason is that there is only ever one file. #A5's premise ("two
  hand-maintained sources… no test asserts they stay in sync") should be read
  as describing a repo layout that no longer exists.
:::

## Verification

`bun test` and `bun run build` both exit 0. Then `./reload.sh` and reload the
VS Code window (Cmd+R, **Developer: Reload Window**) — per `CLAUDE.md` the
installed extension serves the old bundle until reinstalled, so any visual
check before this step is checking stale code.

With the panel reopened (**Waypoint: Open Plan Viewer**):

1. Open `.waypoint/plans/diagram-test-plan.md`. Every diagram's type is at
   least as large as the prose beside it; the wide `LR` phase scrolls; no
   diagram is clickable and none shows a `zoom-in` cursor.
2. Open `.waypoint/plans/sample-mermaid-showcase.md` — a plan written before
   this change — and confirm its three diagram types (flowchart, sequence,
   state) all size correctly. This is the regression check that the fit rule is
   type-agnostic (#A4/#D1).
3. Drag the card between 560px and 920px with a diagram on screen: diagrams
   re-fit live, and comments beside them stay aligned.
4. End to end on the authoring side: run `/waypoint` on a small task touching
   two subsystems and confirm the produced plan puts a diagram in the phase
   that introduces new flow, rather than one diagram at the top — and that
   phases with nothing structural to show carry none.
