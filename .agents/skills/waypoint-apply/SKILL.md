---
name: waypoint-apply
description: Apply pending Waypoint review comments to their plan files.
---

Apply pending plan-review feedback from the Waypoint viewer. Review requests are
written as `*.review.md` files in `.waypoint/plans/` (relative to the repo
root / your current working directory).

For each `*.review.md` file there:

1. Read it. It names the target plan and lists, per comment, a quoted section of
   the plan followed by a `Feedback:` line. It may also carry these sections:
   - `## Direct plan edits` and `## Gate changes`: text the reviewer edited, and
     acceptance-gate criteria they added or removed, **in the plan file
     itself**. These are already saved — never re-apply them and never revert
     them. Read each as a statement of intent and reconcile the rest of the plan
     with it: dependent phases, callouts, gates, and the Verification section.
     Keep every added criterion; if one is not yet checkable (no command, no
     expected output), make it checkable rather than dropping it. Never restore
     a removed criterion. A reviewer's edit can contradict a callout you wrote —
     when it does, the edit wins and the callout is rewritten around it.
   - `## Callout verdicts`: the reviewer's reactions to individual
     `:::assumption` / `:::decision` entries, each with the quoted entry and an
     instruction. Callouts are **accepted by default** — the absence of a
     verdict means the callout stands and may be relied on, so apply acts only
     on **rejections**: a rejected assumption or decision means reworking the
     plan so it no longer depends on it. An explicit accept confirms the callout
     but needs no plan change.
2. Open the corresponding plan file — same name with the `.review` suffix removed
   (e.g. `add-auth.review.md` → `add-auth.md`) — and revise each quoted section
   **in place** to address its feedback. Keep the rest of the plan intact. Your
   edit produces the next version of the plan.
   IDs are stable across versions: never renumber or reassign an existing
   assumption, decision, or criterion ID (`A1`, `D2`, `C7`); new items take
   fresh unused IDs, and a deleted item's ID is never reused.
   Every callout entry you rewrite gains a `revised(v<n>)` token on its opening
   line, where n = the number of sealed versions under `versions/<slug>/` plus
   one — the version your edit produces. Do not re-stamp entries you did not
   touch.
3. If the review contains a `## Cross-cutting comments` section, each such
   comment is a whole-plan pass, not a local edit: apply it everywhere it
   bites, mark every revised callout per the rule above, and end your summary
   with the full list of sections and IDs you touched. Do this pass after the
   local edits so it sees their results.
4. Leave the `*.review.md` file alone — Waypoint files it into
   `versions/<slug>/` itself once the round closes, so it survives as the
   record of what was asked. Do not delete it, do not move it, and do not
   touch anything else under `.comments/` or `versions/`; the viewer already
   sealed the previous version and cleared its active comments when the review
   was sent. A review file still sitting there when you finish is normal.
5. Briefly summarize what you changed. If the review carried direct edits or
   gate changes, say in one line what you reconciled because of them, so the
   reviewer can see their edits were read rather than merely left in place.
6. Tell the viewer you are done, as the last thing you do:

   ```sh
   python3 .claude/skills/waypoint/scripts/signal.py apply_finished --changed
   ```

   Pass `--no-changed` instead when you read the review and concluded the plan
   needed no edit. This is a signal, not a gate: the viewer spins "Writing
   v<n>…" from the moment the reviewer pressed Send, and it cannot tell "no
   change needed" from a stopped agent on its own. Skipping the call costs the
   reviewer a wait, never correctness — so never let it stop you, and never
   report it as a failure.

If there are no `*.review.md` files, reply "No pending Waypoint reviews." and
stop (no signal — nothing was waiting on you). Only refine the plan document —
do not start implementing the plan itself until the user approves.
