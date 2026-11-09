// Derive implementation progress from a plan's markdown: each `## Phase N …`
// section with a `:::checklist` acceptance gate becomes a step, and its progress
// is the fraction of `- [x]` criteria. The agent ticks criteria in the plan file
// as it implements, so this indicator advances live via the file watcher — no
// separate progress channel needed.

import { makeFenceTracker } from "./fences";

export type PhaseInfo = {
  title: string; // full heading text
  label: string; // short label, e.g. "Phase 1"
  total: number; // acceptance criteria in the phase
  checked: number; // criteria marked done
  done: boolean; // total > 0 && checked === total
};

function shortLabel(title: string): string {
  const m = /^(phase\s+\d+)/i.exec(title);
  if (!m) return title;
  return m[1].replace(/^\w/, (c) => c.toUpperCase()).replace(/phase/i, "Phase");
}

export function parsePhases(md: string): PhaseInfo[] {
  const phases: PhaseInfo[] = [];
  let cur: PhaseInfo | null = null;
  let inChecklist = false;
  const fenced = makeFenceTracker();

  for (const line of md.split("\n")) {
    // Fenced examples quoting plan syntax are inert — a fenced `## Phase`
    // heading or checkbox line must not count.
    if (fenced(line)) continue;
    // `## Heading` (but not `### …`) starts a top-level section.
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      const title = line.replace(/^##\s+/, "").trim();
      if (/^phase\b/i.test(title)) {
        cur = { title, label: shortLabel(title), total: 0, checked: 0, done: false };
        phases.push(cur);
      } else {
        cur = null; // Context / Verification / etc. — not a phase
      }
      inChecklist = false;
      continue;
    }
    if (/^:::checklist\b/.test(line)) {
      inChecklist = true;
      continue;
    }
    if (/^:::/.test(line)) {
      inChecklist = false; // any other fence (incl. the checklist's closing :::)
      continue;
    }
    if (inChecklist && cur) {
      const m = /^\s*-\s*\[([ xX])\]\s+/.exec(line);
      if (m) {
        cur.total++;
        if (m[1].toLowerCase() === "x") cur.checked++;
      }
    }
  }

  for (const p of phases) p.done = p.total > 0 && p.checked === p.total;
  return phases;
}

/** Index of the phase currently in progress (first not-done), or -1 if all done. */
export function activePhaseIndex(phases: PhaseInfo[]): number {
  return phases.findIndex((p) => !p.done);
}

/**
 * True when every phase in the 1..upTo prefix is complete. `done` is false for
 * zero-criteria phases, so those need the explicit `total === 0` escape — a
 * phase with no gate cannot block the prefix.
 */
export function prefixDone(phases: PhaseInfo[], upTo: number): boolean {
  if (upTo < 1 || phases.length === 0) return false;
  return phases
    .slice(0, Math.min(upTo, phases.length))
    .every((p) => p.total === 0 || p.done);
}
