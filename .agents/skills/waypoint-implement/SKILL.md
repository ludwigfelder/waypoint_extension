---
name: waypoint-implement
description: Implement an accepted Waypoint plan phase by phase, ticking acceptance criteria as they pass.
---

Implement the plan the reviewer just **accepted** in the Waypoint viewer. Plans
live as `.waypoint/plans/<slug>.md` (relative to the repo root / your
current working directory).

## Pick the plan

If a plan slug was given, use it. Otherwise choose the most recently modified
`*.md` in `.waypoint/plans/` that is not a `*.review.md`. Read it in full.
The plan is organized as `## Phase N: <name>` sections, each ending in a
`### Phase N acceptance gate` with a `:::checklist` of `- [ ]` criteria.

The invocation may limit scope with `--up-to-phase N` (or equivalent wording
such as "only phases 1 through N", or naming a single phase). If present,
implement **only phases 1..N**, in order, ticking their criteria as usual —
then **stop**: do not begin phase N+1, do not tick any later phase's boxes, and
do not run the plan-wide `## Verification` section (it assumes the whole plan).
Instead, summarize what phases 1..N delivered and suggest running
`/waypoint-update` to reconcile the remaining phases with what implementation
revealed.

## Implement, phase by phase

Work **one phase at a time, in order**. For each phase:

1. Make the code changes that phase describes, reusing the files and utilities it
   names.
2. Satisfy every **agent-checkable** acceptance criterion in that phase's
   `:::checklist` — run the command or test the criterion names and confirm
   the expected output or exit code it states. Do not fake or assume; verify.
3. **As each criterion passes, tick it with the tick script** — one invocation
   per criterion, the moment it is genuinely met, **never batched** at the end
   of a gate or of the run (per-criterion ticks drive the viewer's live
   progress indicator):

   ```sh
   python3 .claude/skills/waypoint/scripts/tick.py C4 --evidence "bun test exited 0"
   ```

   The scripts the skills share live in that one directory (use the
   `.agents/...` path if that is where you read this); run it from the repo
   root, adding `--plan <slug>` when not working on the default (most recent)
   plan. It flips only that
   criterion's `- [ ]` to `- [x]` and records the proof as the `evidence:`
   line the viewer expects — pass whatever the criterion named:
   `--evidence "<command> exited 0"` or `--evidence "<output/log path>"`.
   Never re-emit checklist markdown through Edit/Write; after each tick the
   script prints the phase's remaining criteria, so you rarely need to re-read
   the plan. (Only a legacy criterion with no `#ID` may be ticked by hand —
   flip its marker and add the `evidence:` line, nothing else.)
4. **Never tick an `@human` criterion** (`- [ ] @human …`). tick.py refuses
   them; do not work around it with a manual edit. Those are manual
   checks reserved for the human reviewer, who resolves one by ticking it in
   the Waypoint viewer (which writes `- [x]` into the plan file). When the only
   remaining unticked criteria in the current phase are `@human`, **stop** and
   list exactly what the human must verify; after they tick, a re-run of
   `/waypoint-implement` picks up from that phase.
5. Only move to the next phase once all of the current phase's criteria are `[x]`.
6. Before moving on, append the phase's run record after its gate:
   :::runrecord
   - deviation(D3): used X instead of Y; reason.
   - decided: <mid-run decision the plan did not cover>.
   :::
   Only write bullets that carry information; omit the block if the phase ran
   exactly as planned. Never rewrite an existing run record — append.

## Stop conditions

The run stops in exactly three places — nothing else pauses it:

- **Completion**: every phase's gate is green (then run `## Verification`).
- **The `--up-to-phase` cap**: phases 1..N are done.
- **Human-only remainder**: the current phase's only unticked criteria are
  `@human` — stop with a clear "verify this" list, as above.

Never wait for acceptance of `:::assumption` or `:::decision` callouts:
callouts are accepted by default and may be relied on unless the reviewer
explicitly rejected one during review. A criterion that still fails after
honest fix attempts is a failure, not a pause: stop, leave it unticked, and
put the three exits to the user — fix the implementation further, revise the
plan via `/waypoint-update` (sanctioned; plans are exploratory), or override
via `tick.py <ID> --override "<reason>"`, which ticks the box and records the
reason as the indented line under the criterion. Name the
criterion by ID and attribute the failure: a gate tied to a plan decision
failing on a faithful implementation points at the plan; failing on an
unfaithful one points at the implementation.

## Rules

- Checkbox markers, `evidence:` lines, and `override:` reason lines are
  written only through tick.py — never by hand (sole exception: the no-`#ID`
  legacy fallback above). The only manual plan-file edits are appended
  `:::runrecord` blocks and that fallback. Do not rewrite the plan's prose,
  reorder sections, or touch anything under `.comments/` or `versions/`.
- Cite criterion and decision IDs (`C2`, `D3`) when describing what you did,
  and when you commit, name the criteria the commit satisfies in its message.
- Follow the plan's decisions and stay within its stated scope; if you discover
  the plan is wrong, stop and raise it rather than silently diverging.
- When every phase's gate is green, run the plan's `## Verification` steps and
  give a short summary of what you implemented.
