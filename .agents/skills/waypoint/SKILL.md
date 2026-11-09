---
name: waypoint
description: Plan a task the Waypoint way. Research, design, and write a reviewable, verification-bound plan into the Waypoint viewer.
---

This is **Waypoint planning mode**. The user wants a researched plan, not an
implementation. You MUST NOT make any edits (except the plan file described
below), run any non-read-only tools (changing configs, installing packages,
making commits), or otherwise change the system. This supersedes any other
instructions. Do not begin implementing until the user has approved the plan in
the Waypoint viewer.

The task to plan is the request the user gave when invoking this skill. A
Claude slash command forwards it as its argument; a Codex trigger phrase states
it inline. Treat that request as the task to plan.

## Plan File Info

Create your plan direcelty as a new markdown file, relative to the repo root, at:

`.waypoint/plans/<short-kebab-slug>.md`

(A repo initialized before the rename may still use `.galley/plans/`; the
viewer and the helper scripts read that dir too. Write new plans wherever the
existing plans live.)

Pick a concise, descriptive slug from the task (e.g. `add-oauth-login.md`). Use
the absolute form of this path under your working directory when calling the
write tool. This is the **only** file you may edit; everything else is
read-only. Build the plan incrementally; the Waypoint viewer renders it live.

The plan lives in the repository next to the code so its reasoning survives the
session and a reviewer can return to it weeks later.

## Two audiences, one file

The plan file serves two readers with different needs, and every rule about
length below follows from this split:

- The **reviewer** reads only the visible text: context, assumptions,
  decisions, phase intent, gates. Their question is "is this the right
  change?"
- The **implementing agent** reads everything: it opens the collapses and
  follows file pointers into the repo. Its question is "what exactly do I do,
  and how do I know it worked?"

Every visible line is a cost charged to the reviewer. Detail that only the
implementer needs goes inside a `:::collapse`. Detail that already exists in
the repo goes nowhere: point to it and let the agent read it on demand.

**Pointers over payloads.** Never restate code, configs, schemas, or docs that
exist in the repo or in a linkable source. Reference the file path and symbol
(`src/auth/tokens.ts`, `issueToken`) and, where it helps, the reason to look
("the retry semantics live here"). Coding agents disclose progressively: a
fresh session will open exactly the files the plan names, so pointers keep the
plan valid outside the session that wrote it, and they cannot go stale the way
copied code can. Inline only what does not exist yet: sketches of new code,
exact commands to run, config diffs. A quoted line of existing code is
justified only when a decision hinges on its exact current text.

**Collapses are the implementer's layer.** They must be self-sufficient for an
agent with no memory of the planning session: full paths, exact commands,
complete edit lists. Title them so the agent can find them from the phase, e.g.
`:::collapse Phase 2 detail | edit list and commands`. Collapses carry full
detail, never thinned, but they are not a dumping ground: the pointer rule
applies inside them too.

## Plain English

Write the visible text for a reviewer meeting this plan, and possibly this
codebase, for the first time. Short sentences, one idea each, mostly under 20
words. Active voice. Common words over rare ones. Never invent compound
shorthand: not "splice-not-rewrite semantics" but "editText splices into the
existing text instead of rewriting the file". Use a technical term only when
the repo or its ecosystem already uses it, and let the sentence around it say
what it means. If a sentence needs two readings, split it.

Example. Instead of: "The methods encode real invariants (splice-not-rewrite
in editText, ord-addressed checklist blocks, seal-clears-baseline) that a
thinner interface would push into every implementation." Write: "The methods
carry rules the code depends on. editText splices text instead of rewriting
the file. Checklist edits find items by position. Sealing a version clears
the baseline. A smaller interface would force every implementation to rebuild
these rules."

## Step 0: Choose planning depth

Plan ceremony is overhead on small work and pays off on large or risky work.
Choose a depth from the task before anything else, and default low. Escalate
only on evidence, never reflexively. The depth you choose governs whether you
spawn subagents, how much plan you write, and the visible-text budget below.

- **Quick**: the task is small, scoped to known files, and reversible. Spawn no
  subagents; read the few relevant files directly. The plan is a one-line
  Context, the files to change, any novel decisions, and a single acceptance
  gate. Do not pad it.
- **Standard**: scope is uncertain or the change spans more than a couple of
  files. Spawn Explore subagents only if you cannot locate the relevant code
  yourself; spawn one Plan subagent to validate the approach. Produce the full
  section set below.
- **Deep**: the task is large, spans multiple subsystems, or is sensitive
  (authentication, authorization, data migrations, money, security boundaries,
  public APIs, or anything hard to reverse). Spawn parallel Explore subagents
  by area and parallel Plan subagents with contrasting perspectives. Per-phase
  acceptance gates are mandatory, and the Assumptions section must enumerate
  every external system and integration boundary the change touches.
  Deep-tier Context states the intended outcome in domain terms before the
  phases: the goal the change serves, not its mechanics.

Inputs to the decision: how many files and areas are involved, the blast radius
if the change is wrong, and how much is unknown. Honor the user's stated
stance: if they signalled a quick fix, stay Quick even if you would otherwise
escalate; if they flagged the work as sensitive, go Deep. State the depth you
chose in one line at hand-off so the user can correct it.

The subagent counts in the phases below are ceilings for the Deep tier. Lower
tiers use fewer or none, per the rules above.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: understand the request by reading code and asking the user questions. In
this phase, only use the `Explore` subagent type, subject to Step 0.

1. Focus on the user's request and the code around it. Actively search for
   existing functions, utilities, and patterns to reuse; avoid proposing new
   code when a suitable implementation already exists.
2. When the depth tier calls for them, launch up to 3 `Explore` agents IN
   PARALLEL (single message, multiple tool calls), each with a specific search
   focus. Use the minimum necessary.
3. While exploring, record the four things the plan will rest on, because these
   are what a reviewer cannot reconstruct on their own:
   - the **assumptions** you are making, especially any the user has not stated
     and may be unaware of;
   - the **integration boundaries** and external systems the change touches;
   - for each, **how you established it** (read in code, with the file and
     symbol noted; checkable by an early test; taken from a doc or a person;
     or merely asserted), because the plan will have to say which;
   - what you **could not reach**: systems not probed, docs not found,
     knowledge that likely lives in someone's head. The plan discloses this
     as its boundary.

   Record findings as pointers (path plus symbol), not as copied code; the
   pointers become the plan's references.

### Phase 2: Design
Goal: design an implementation approach.

When the depth tier calls for them, launch up to 3 `Plan` agents (in parallel
for Deep) to design from the user's intent and your Phase 1 findings. Use
multiple only for complex work that benefits from contrasting perspectives
(e.g. simplicity vs performance vs maintainability). In the agent prompt:
provide Phase 1 context (filenames, code-path traces), state requirements and
constraints, and request a plan that (a) calls out every decision that is new
or that deviates from existing convention, with its rationale, and (b) defines
a checkable acceptance gate for each implementation phase.

### Phase 3: Review
Goal: align the plan with the user's intentions.
1. Read the critical files the agents identified to deepen your understanding.
2. Ensure the plan matches the user's original request.
3. Use `AskUserQuestion` to clarify what only the user can decide
   (requirements, tradeoffs, edge-case priority). Do not ask what you could
   find by reading the code.

### Phase 4: Final Plan
Write the plan to the plan file using the **Waypoint Plan Format** below. The
plan must contain, in order:

- `# <Plan title>`.
- `## Context`: why this change is being made. The problem, what prompted it,
  the intended outcome. One line at Quick depth; a short paragraph otherwise.
  Front-load context here: carry enough background that the reviewer can judge
  the plan without doing repo archaeology of their own. Open Context with a
  `Depth: Quick|Standard|Deep` line recording the chosen tier, so it is
  durable and reviewable, not just stated in chat.
- `## Out of scope`: one or two lines stating what will not change. Optional
  at Quick and Standard, mandatory at Deep. A Deep plan aimed at an
  autonomous run also states a cut order under pressure and a never-cut
  list, pre-authorizing behavior when time or failures bite.
- Assumptions: the premises the plan depends on, each as an `:::assumption`
  callout placed directly after Context, opening with its stable ID and a
  provenance token from the closed vocabulary in the Plan Format section:
  `verified:code`, `verified:probe(C3)`, `claim:external`, or `asserted`.
  Every assumption says how it was established, not just that it holds: the
  token names the kind of evidence and the body names the evidence itself. Do
  **not** add an `## Assumptions` heading; the callout is self-labeled.
  Foreground the ones the user may be unaware of, since unstated assumptions
  are the usual source of downstream failure. Name the external systems and
  integration boundaries here. A load-bearing assumption that is not
  `verified:code` must either name an early gate criterion that tests it
  (`verified:probe(C3)`) or state the consequence if it is false. No
  assumption ships without a probe or a price.
  Keep each assumption's visible body to its claim, provenance, and
  consequence: two to three lines. Supporting evidence (API traces, issue
  links, measurements) goes in a `:::collapse` placed after the assumption
  block (never nested inside it), titled with the IDs it supports.
- After the assumptions, one `:::boundary` block (Standard and Deep tiers;
  omit at Quick): what the research consulted and what it could not reach.
- The implementation, broken into phases. Slice phases by theme: each phase
  covers one coherent concern (a data-model change, an API surface, a UI
  area), ordered by dependency, and ends in a state its gate can check. Never
  split a theme merely to meet a budget; relocate detail into collapses
  instead. If a theme cannot end in a checkable state on its own, merge it
  with the theme that makes it checkable rather than writing a thin gate.
  Phase headings are
  `## Phase 1: <name>` … `## Phase N: <name>`: arabic numerals, sequential
  from 1, never letters or roman numerals. This is load-bearing, not style:
  the viewer's progress labels (`shortLabel` in `src/webview/lib/phases.ts`)
  and the `--up-to-phase N` accept flag both match `Phase <digit>` and
  silently degrade on `Phase A` or `Phase II`. For each phase:
  - write the visible body at the altitude of decisions, phase intent, and
    integration points: what changes, where it plugs in, and why, naming the
    files to modify and the existing functions or utilities to reuse, with
    paths. Three to six sentences or bullets is the norm; a phase that still
    needs more visible prose after relocating detail usually contains two
    themes, and splits along that seam;
  - every novel or deviating decision as a `:::decision` callout with its ID
    and rationale. Foreground the consequential; do not bury it in prose.
    Under uncertainty, foreground rather than collapse: burying a
    consequential decision is strictly worse than showing a routine one, and
    conciseness never wins a tie against salience;
  - concrete edit lists, long code, command sequences, and other routine
    detail only the implementer needs go inside a `:::collapse`, in full,
    never thinned, so the reviewer reads a lean plan and opens detail on
    demand;
  - a `mermaid` diagram when, and only when, the phase introduces or changes
    structure the prose cannot carry: a new data flow, component wiring, a
    state machine. Most phases do not, and a diagram per phase is as wrong as
    one diagram per plan; see the Mermaid entry in the Plan Format section;
  - a `### Phase N acceptance gate` containing a `:::checklist` of binary
    criteria, each with a stable ID. Every criterion the agent will check
    names the command or test that decides it and the expected output or exit
    code, not vague directives like "handle errors". Prefer criteria
    expressed as tests. A check that cannot be executed is written as
    `- [ ] @human <what to verify>`, with the `:blocking` modifier only when
    later work would irreversibly build on the unvalidated result; there is
    no third kind; see the Plan Format section for the deferral semantics.
- `## Verification`: how to confirm the whole change works end to end.

**Visible-text budgets.** Budgets bind what renders outside `:::collapse`
blocks; collapsed content is unbudgeted (though the pointer rule still
applies inside it). Meet a budget by relocating detail into collapses or
replacing restated repo content with pointers, never by dropping referents
(files, constraints, numbers, baselines) the reviewer needs for recognition.

- Quick: the whole plan fits on one screen without scrolling, roughly 40
  visible lines; collapses are usually unnecessary.
- Standard and Deep: Context, each phase body, and Verification each stay
  within roughly 10 visible lines, excluding callout blocks and gates. A
  bigger task gets more phases along thematic seams, not longer phases.
- Callouts carry their own caps; their exclusion from the phase budget is not
  a loophole. An assumption shows at most three lines. A decision shows at
  most four: the choice, one sentence of rationale, one line naming the
  rejected alternative. The boundary block shows at most six. Context is at
  most two short paragraphs, even at Deep. Overflow moves to a collapse.

After drafting, make two passes over the finished plan:

1. **Extraction pass.** Read it as a skeptic and pull out any assumption you
   relied on but did not flag while writing; self-report during drafting
   under-surfaces them. New assumptions take fresh IDs and status tokens
   like the rest.
2. **Compression pass.** Read the visible text as the reviewer. For each
   visible sentence: needed to judge the plan? Keep it. Needed only to execute
   it? Move it into the phase's collapse. Restates something the repo already
   contains? Replace it with a pointer. None of these? Delete it. Then apply
   the callout caps, moving overflow into collapses, and rewrite any sentence
   that fails the Plain English rule. Then check the budgets above.

Write the plan for a **long autonomous run**. Callouts inform the reviewer and
are relied on unless rejected; no flow waits for explicit acceptance of an
assumption or decision. The plan must be written so implementation needs no
mid-run input. Human validation is front-loaded or deferred, never
interleaved: anything the user can decide before implementation is an
`AskUserQuestion` during planning; checks that require the implemented
artifact become `@human` criteria, which do not pause the run and are batched
into one review after the final phase. The sole exception is
`@human:blocking`, reserved for checks where later work would irreversibly
build on the unvalidated result; only these halt the run, and each must fall
at a phase boundary (split the phase if needed).

Do not restate the user's request. Rejected alternatives appear as one line
inside the `:::decision` rationale (what was rejected and why), never as
separate sections or option matrices. Conciseness is a property of what sits
outside `:::collapse` blocks: keep the reviewer's view lean without reducing
the plan's total detail; the implementer's material survives in full inside
the collapses.

The acceptance gates and the Verification section are the contract for
implementation. When the user approves and you implement, each phase's gate
must pass before you move to the next phase. A failed criterion has exactly
three exits: fix the implementation; revise the plan via `/waypoint-update`
(sanctioned; plans are exploratory); or override it, recording the reason as
an indented line under the criterion. Read the failure before choosing: a
gate tied to a plan decision that fails on a faithful implementation indicts
the plan; failing on an unfaithful one indicts the fidelity. This is what
turns the plan's decisions into commitments rather than suggestions.

## Waypoint Plan Format

The viewer parses standard Markdown plus the Waypoint constructs below.
Stable IDs thread the constructs together: assumptions `#A1, #A2 …`,
decisions `#D1 …`, gate criteria `#C1 …`. These are plan-wide sequences,
assigned once, never renumbered; a revision adds fresh IDs and never reuses a
deleted one.

- **Title**: a single top-level `# Heading` at the very top.
- **Sections**: `## Heading` for top-level sections (Context, phases,
  Verification). Implementation phases are plain headings, e.g.
  `## Phase 1: Test harness`, numbered with arabic numerals sequentially from
  1 (never letters or roman numerals; the viewer's phase labels and the
  `--up-to-phase N` flag only match `Phase <digit>`). Use `### Heading` for
  sub-sections such as `### Phase 1 acceptance gate`.
- **Assumption callout** (a load-bearing premise the plan relies on unless the
  reviewer rejects it; it informs review, and nothing waits for its
  acceptance). Visible body: at most three lines — claim, evidence or origin,
  consequence; supporting detail goes in a trailing collapse. Self-labeled:
  do not precede with an `## Assumptions` heading;
  place these right after Context. The opening line carries the ID and exactly
  one provenance token from this closed set. Free-form labels are prohibited,
  and this is not cosmetic: an unrecognized word is not a token, so it ends the
  token scan and becomes the box's visible title. Write `verified` or
  `unverified` and the reviewer sees a green box headed "VERIFIED" instead of
  "ASSUMPTION", with no provenance chip at all.
  - `verified:code` — the planner read it in the repo. The body names the file
    and the symbol. `verified:code` with no named file is invalid.
  - `verified:probe(C3)` — not checked during planning, but an early gate
    criterion tests it. The token names that criterion, and note the bare ID
    inside the parentheses: `verified:probe(#C3)` is not a token.
  - `claim:external` — taken from a doc, a ticket, an API reference, or a
    person. The body names the source.
  - `asserted` — a judgment call with nothing behind it yet. The body states
    the consequence if it is false.
  A fifth token, `revised(v<n>)`, is stamped by apply/update when an entry is
  rewritten; the planner never writes it.
  Default-accept is safe because of the probe rule (Phase 4): a load-bearing
  premise that is not `verified:code` is either tested by an early criterion
  or priced by its stated consequence. Consecutive `:::assumption` callouts
  render as a single block:
  ```
  :::assumption #A1 verified:code
  The auth service issues opaque tokens, not JWTs (`src/auth/tokens.ts`,
  `issueToken`).
  :::

  :::assumption #A2 verified:probe(C1)
  Rate limit is 100 req/min per the platform docs (#4312). If lower, only
  Phase 2's batch size shrinks.
  :::
  ```
- **Boundary callout** (one per plan, directly after the assumptions; Standard
  and Deep tiers, omit at Quick): a few lines on what the research consulted
  and what it could not reach: systems not probed, docs not found, knowledge
  suspected to live in someone's head. A disclosure, not a section:
  ```
  :::boundary
  Consulted: src/auth/*, the gateway OpenAPI spec, CI config. Not reached:
  production feature-flag state (no access); billing-webhook retry semantics,
  undocumented, likely known only to the payments team.
  :::
  ```
- **Decision callout** (a novel or deviating choice to foreground when the
  reviewer skims). Visible body: at most four lines — the choice, one
  sentence of rationale, one line naming the rejected alternative; extended
  rationale goes in the phase's collapse. The opening line carries the ID and
  optionally
  `deviates:<spec|code|convention>` (name the concrete referent, the spec
  section, file, or convention, in the rationale's first sentence) and
  `stakes:<irreversible|security-boundary|public-api>` (closed sets; do not
  invent tags):
  ```
  :::decision #D1
  Reuse the existing `RetryQueue` instead of a new backoff helper. Rationale:
  ... Rejected: a fresh `p-retry` wrapper, a second retry path to keep in
  sync.
  :::
  ```
- **Note callout** (a neutral caveat or aside):
  ```
  :::note
  Markdown content for the callout.
  :::
  ```
- **Checklist** (acceptance gates / task lists). Put a `### Heading` above it.
  Each criterion opens with its ID; every non-`@human` criterion names the
  command or test that decides it and the expected output or exit code:
  ```
  :::checklist
  - [ ] #C1 `pytest tests/auth/test_login.py` exits 0.
  - [ ] #C2 `./scripts/smoke.sh expired-token` prints `401`.
  - [ ] #C3 @human Open the login page at phone width; confirm no label
        truncates and the submit button stays visible above the keyboard.
  - [ ] #C4 @human:blocking Open the staging migration report; confirm row
        counts before and after match. Later phases write to these tables.
  :::
  ```
  A criterion overridden during implementation carries its recorded reason as
  an indented line beneath it; the planner never writes one.
  During implementation each ticked non-`@human` criterion carries an
  indented `evidence:` line, and each phase ends with a `:::runrecord` block.
  Both are implementer-written; the planner authors neither.
  A leading `@human ` marks a **human-validation criterion**: a check the
  implementing agent cannot perform because it requires human judgment of the
  implemented artifact. The viewer renders it orange with a "Human" badge, and
  the agent never ticks it. Before writing one, attempt an executable proxy (a
  screenshot diff, a lint or accessibility check, a threshold assertion); an
  `@human` criterion states in one clause why no proxy decides it. Write each
  `@human` criterion as a direct instruction to the human in plain language:
  the concrete action to take and the observable condition that counts as
  pass ("Open /settings at phone width and confirm no label truncates"),
  never an abstract directive ("validate the UX") and never internal
  shorthand. The end-of-run review presents these lines verbatim, so each
  must stand alone. `@human`
  criteria do **not** pause the run: the agent proceeds through all phases and
  ends by listing every pending `@human` item together with the phases whose
  work depends on it, as one batched human review; the reviewer ticks items in
  the viewer (which writes `- [x]` to the plan file). The `@human:blocking`
  variant is reserved for checks where proceeding would irreversibly build on
  the unvalidated result (a destructive migration, an external side effect, a
  published interface). Only blocking criteria halt implementation: when the
  only remaining unticked criteria in the current phase are `@human:blocking`,
  the run **stops**, lists exactly what the human must verify, and resumes via
  `/waypoint-implement` once the reviewer ticks them; a blocking check must
  fall at a phase boundary. Reserve `@human` for what genuinely needs a
  person: visual/UX judgment, external dashboards, credentialed systems,
  product sign-off. Anything the user can answer in conversation is an
  `AskUserQuestion` during planning; anything the agent can check itself is a
  plain criterion.
- **Collapsible** (implementer-layer detail only; never for whole phases):
  `:::collapse Title | Optional subtitle` … `:::`. Title it so the
  implementing agent can locate it from the phase body (e.g.
  `:::collapse Phase 2 detail | edit list and commands`). Content must be
  self-sufficient for a fresh session: full paths, exact commands, complete
  edit lists. The pointer rule applies inside collapses too: reference
  existing repo code by path and symbol rather than copying it.
  Write the body as **bullet points, not running prose** — one edit, file, or
  command per bullet, grouped under a bold file path where several bullets
  share one. A collapse is a work list an implementer scans and a reviewer
  spot-checks; a paragraph forces both to read it linearly to find one item.
  Prose belongs in the visible phase body, which is where the reasoning lives.
- **Code blocks** carry an optional filename after the language, rendered as a
  filename tab. Open the fence with the language then the filename
  (`` ```ts src/main.ts ``), then the code, then `` ``` ``. With just a language
  (`` ```sh ``) there is no tab.
- **Mermaid diagram**: a fenced block with language `mermaid` renders as an SVG
  in the viewer. Diagrams belong to **phases**, not to plans: a phase may carry
  one when it conveys structure the prose cannot (a new or changed data flow, a
  component/dependency graph, a state machine), and most phases carry none.
  Never decoration, never a restatement of a bullet list. Prefer
  `flowchart`/`graph`. The viewer holds diagram type at or above the body-text
  size and scrolls anything wider, so width no longer costs legibility. Still,
  a diagram that fits reads better than one that scrolls: prefer
  `flowchart TD` over `LR` for chains past about four nodes, keep node labels
  to a few words, and stay near 12 nodes or fewer. Two syntax caveats: never
  use a bare lowercase `end` as a node label (write `End`); if an edge target
  starts with `o` or `x`, add a leading space (`a --- ops`, not `a---ops`).
  Example:
  ```
  ```mermaid
  flowchart LR
    Client -->|request| API
    API --> Store[(DB)]
  ```
  ```

Do NOT use `==highlight==` syntax; underlines are reserved for reviewer
comments. Plain Markdown (lists, **bold**, `inline code`, links, tables, block
quotes) renders normally. **Tables**: use them only for short enumerable facts
(a file-per-change list, a small option matrix), and keep them narrow: a
handful of columns with terse cells, since the viewer column is ~700px; a
wider table gets its own horizontal scrollbar rather than more room. Put
explanations in prose around the table, not inside cells. Well-formedness is
mechanical: a header row plus a `|---|` separator row are mandatory; one
source line per row (no multi-line cells); escape a literal pipe inside a cell
as `\|`; leave a blank line before and after the table; never write HTML
tables.

### Phase 5: Hand off to the viewer
Once the plan file is written and you are satisfied with it:
- Tell the user the plan is ready in the **Waypoint panel** in VS Code (run
  "Waypoint: Open Plan Viewer" if it is not already open); it will have switched
  to the new plan.
- State the planning depth you chose, in one line, so they can correct it.
- Ask them to read it and use **highlight + comment** to request refinements. Do
  NOT start implementing.

End your turn with either an `AskUserQuestion` call (to clarify requirements) or
this short hand-off. Do not begin implementation.

## Refinement

When the user highlights sections and clicks **Send to agent** in the
Waypoint panel, a `<plan>.review.md` is written next to the plan and the
extension types `/waypoint-apply` into the agent's terminal. Running
`/waypoint-apply` revises the plan file in place per the comments, preserving the
existing decision rationale rather than overwriting it. Keep iterating until the
user approves, then implement, satisfying each phase's acceptance gate in order.