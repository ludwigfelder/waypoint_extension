---
name: waypoint-update
description: Revise an existing Waypoint plan against new information — partial implementation state, experiment results, or reviewer notes — without starting to implement.
---

Revise an existing Waypoint plan against new information. This is the engine
behind the viewer's **Reflect** action, and it can also be invoked by hand with
notes. It updates the plan document only — it never implements.

## Pick the plan

If a plan slug was given, use it. Otherwise choose the most recently modified
`*.md` in `.waypoint/plans/` (relative to the repo root / your current working
directory) that is not a `*.review.md`. Read it in full. Any free text after
the slug in the invocation is reviewer notes — treat it as input to the
revision.

## Gather what changed

Before rewriting anything, establish the delta between the plan and reality:

- **Checklist state**: which acceptance criteria are `[x]` vs `[ ]`, phase by
  phase. Fully-ticked phases are done; partially-ticked phases are in flight.
- **The working tree**: diff the code since the plan was written (`git status`,
  `git diff`, recent commits) to see what implementation actually did — which
  may diverge from what the plan prescribed.
- **The notes**: any free-text notes in the invocation (experiment outcomes,
  changed requirements, discovered blockers, a failed gate criterion routed
  here for revision — the sanctioned second exit of the failure policy).

## Seal the old version first

Every revision is a new version of the plan; the version it replaces stays on
disk unchanged, with a one-line note saying why it was superseded. That is the
plan's history, and the viewer shows it in the version menu. Once you have
decided the plan needs an edit — and **before your first write** — run:

```sh
python3 .claude/skills/waypoint-update/scripts/seal.py --reason "<why, one line>"
```

Use the `.agents/...` path if that is where you read this; run it from the repo
root, adding `--plan <slug>` when not working on the newest plan. The reason is
the delta you just established, stated for someone reading the history later
("Phase 2 gate C4 failed: the migration needs a backfill step", "reviewer
notes: drop the cache layer"), not a description of the edit. The script
snapshots the plan, its comments, and the edit baseline exactly as the viewer's
Send back does, and prints the number of the version you are about to write —
that number is the `n` in the `revised(v<n>)` stamps below. It is safe after
the viewer's Reflect, which sealed already: it then only records your reason.
Never copy files under `versions/` by hand, and do not run it when the new
information warrants no edit (a version identical to its predecessor is noise).

## Rewrite the remaining phases

- **Preserve completed phases and their `[x]` marks verbatim** — byte for
  byte, including their gates, any override reasons, all `evidence:` lines,
  and `:::runrecord` blocks. They are the record of what happened.
- Rewrite only the remaining (unticked or partially-ticked) phases to reflect
  the new information: drop work that turned out unnecessary, add work that
  was revealed, adjust decisions that no longer hold.
- If the structure changes, renumber so phases stay `1..N` sequential arabic
  numerals (never letters or roman numerals — the viewer's progress labels and
  the `--up-to-phase N` flag match `Phase <digit>` only). Completed phases
  keep their numbers; renumber only the rewritten tail.
- **IDs never renumber.** Phase numbers may shift as above; assumption,
  decision, and criterion IDs may not: existing items keep theirs, new items
  take fresh unused IDs, and a deleted item's ID is never reused.
- Keep existing `:::decision` rationale unless the new information invalidates
  it; when it does, revise the callout rather than silently dropping it, and
  stamp the revised entry with `revised(v<n>)` like `/waypoint-apply` does,
  where n is the number `seal.py` printed.
- Follow the waypoint skill's Plan Format throughout (callouts with IDs,
  provenance, referent, stakes, and revised tokens, the `:::boundary` block,
  checklists, `@human` criteria, tables); `evidence:` lines and run records
  are implementation artifacts — never author them in a revision.

## Hand back to the viewer

The update itself does **not** start implementing. When the revised plan is
written, tell the user it is ready for re-review in the Waypoint panel.
Resuming is a single **Accept** (or accept-up-to-phase) click — there is no
per-callout re-review; new or changed callouts are, as always, relied on
unless the reviewer rejects them.

As the last thing you do, tell the viewer the run is over:

```sh
python3 .claude/skills/waypoint/scripts/signal.py update_finished --changed
```

Pass `--no-changed` when the new information turned out to warrant no edit
(in which case nothing was sealed either).
When Reflect started this run the viewer is spinning "Writing v<n>…" and cannot
otherwise tell a finished run from a stopped one. This is a signal, not a gate:
skipping it costs a wait, never correctness. Then end your turn.
