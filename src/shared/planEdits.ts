// The reviewer's direct changes to a plan, derived from the edit-session
// baseline. Inline prose edits and gate criteria added or removed in the viewer
// are written straight into the plan file, so unlike a comment they leave no
// record of themselves — the agent that picks the plan up next cannot tell an
// edited line from one it wrote. Diffing the live plan against the baseline
// recovers that record for the review file.
//
// DOM-free: the host compiles the review with it and the webview counts
// pending changes with it, so both agree on what counts as a change.

import { opcodes } from "./difflib";

export type PlanEditKind = "prose" | "criterion";

export type PlanEdit = {
  kind: PlanEditKind;
  /** Nearest heading above the change, or "" above the first heading. */
  section: string;
  /** Baseline lines the change replaced (empty for a pure insertion). */
  removed: string[];
  /** Live-plan lines it replaced them with (empty for a pure deletion). */
  added: string[];
};

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
/** A gate criterion line. Plans use task-list checkboxes only inside `:::checklist`. */
const CRITERION = /^\s*[-*+]\s*\[[ xX]\]/;

/** The heading in force at each line of `lines`. */
function sectionAt(lines: string[]): string[] {
  const out: string[] = [];
  let current = "";
  let fenced = false;
  for (const line of lines) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : HEADING.exec(line);
    if (m) current = m[2];
    out.push(current);
  }
  return out;
}

/** Drop blank lines from both ends of a hunk side. */
function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === "") a++;
  while (b > a && lines[b - 1].trim() === "") b--;
  return lines.slice(a, b);
}

/**
 * A criterion line with its tick state neutralized. Lines are *matched* on this
 * form, so a tick is invisible to the diff: ticking a box is the reviewer
 * signing off on an `@human` criterion, not a request to revise the plan. It
 * also keeps a tick next door to a real change from being swept into that
 * change's hunk and read as part of it.
 */
const untick = (line: string) => line.replace(/^(\s*[-*+]\s*\[)[xX](\])/, "$1 $2");

/**
 * A hunk counts as a gate change when every non-blank line on both sides is a
 * criterion line — so adding, removing, or rewording a criterion reads as a
 * gate change, while an edit that also touches surrounding prose reads as
 * prose and is shown whole.
 */
function kindOf(removed: string[], added: string[]): PlanEditKind {
  const lines = [...removed, ...added].filter((l) => l.trim() !== "");
  return lines.length && lines.every((l) => CRITERION.test(l)) ? "criterion" : "prose";
}

/**
 * The reviewer's edits to a plan: a line-level diff of `baseline` (the plan as
 * it stood when this round of edits began) against `current` (the live file),
 * grouped into hunks and classified. Returns [] when there is no baseline —
 * i.e. the reviewer has not edited since the last seal.
 */
export function diffPlanEdits(baseline: string, current: string): PlanEdit[] {
  if (!baseline || baseline === current) return [];
  const a = baseline.split("\n");
  const b = current.split("\n");
  const sections = sectionAt(b);
  const out: PlanEdit[] = [];
  for (const [op, i1, i2, j1, j2] of opcodes(a.map(untick), b.map(untick))) {
    if (op === "equal") continue;
    const removed = trimBlank(a.slice(i1, i2));
    const added = trimBlank(b.slice(j1, j2));
    if (!removed.length && !added.length) continue; // whitespace-only churn
    out.push({
      kind: kindOf(removed, added),
      section: sections[Math.min(j1, sections.length - 1)] ?? "",
      removed,
      added,
    });
  }
  return out;
}
