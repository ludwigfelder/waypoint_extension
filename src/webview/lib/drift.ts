// Post-run drift summary (ADJ-21): derive everything from the plan file, the
// same philosophy as the progress banner — no session state. Reads the
// run-record and evidence constructs the implement flow writes, classifies
// ticks (ADJ-13), and runs the two cheap validations that finally have data:
// dangling `verified:probe` references and duplicate IDs.

import { makeFenceTracker } from "./fences";
import { parsePhases } from "./phases";
import { ID_PATTERN, parseCalloutArgs } from "./markdown";

export type DriftSummary = {
  /** All gates green AND the document carries evidence or a run record. */
  postRun: boolean;
  deviations: { id: string; text: string; phase: number }[];
  /** Checked criteria by class: evidence-backed / bare non-@human / @human. */
  ticks: { derived: number; asserted: number; human: number };
  /** `verified:probe(<id>)` refs whose criterion is missing or unticked. */
  danglingProbes: string[];
  duplicateIds: string[];
};

const CRITERION = /^\s*-\s*\[([ xX])\]\s+(.*\S)\s*$/;
const DEVIATION = new RegExp(
  `^\\s*-\\s*deviation\\((${ID_PATTERN})\\):\\s*(.*\\S)\\s*$`,
  "i",
);

export function computeDrift(md: string): DriftSummary {
  const fenced = makeFenceTracker();
  const ids: string[] = [];
  const probeRefs: string[] = [];
  const criteria: { id?: string; checked: boolean; human: boolean; hasEvidence: boolean }[] = [];
  const deviations: DriftSummary["deviations"] = [];
  let hasRunrecord = false;
  let hasEvidence = false;
  let phase = 0;
  let mode: "none" | "checklist" | "runrecord" = "none";
  let last: (typeof criteria)[number] | null = null;

  for (const line of md.split("\n")) {
    if (fenced(line)) continue;

    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      const m = /^##\s+phase\s+(\d+)/i.exec(line);
      phase = m ? +m[1] : 0;
      mode = "none";
      continue;
    }
    if (/^:::checklist\b/.test(line)) {
      mode = "checklist";
      continue;
    }
    if (/^:::runrecord\b/.test(line)) {
      mode = "runrecord";
      hasRunrecord = true;
      continue;
    }
    if (/^:::/.test(line)) {
      const cm = /^:::(assumption|decision)\b[ \t]*(.*)$/.exec(line);
      if (cm) {
        const meta = parseCalloutArgs(cm[1], cm[2].trim());
        if (meta.id) ids.push(meta.id);
        if (meta.statusRef) probeRefs.push(meta.statusRef);
      }
      mode = "none"; // any other fence line closes checklist/runrecord scope
      continue;
    }

    if (mode === "checklist") {
      const im = CRITERION.exec(line);
      if (im) {
        // Leading `#<id>` / `@human` tokens, each at most once, either order —
        // mirrors the tokenizer in markdown.ts.
        let rest = im[2];
        let human = false;
        let id: string | undefined;
        for (;;) {
          let t: RegExpExecArray | null;
          if (!human && (t = /^@human\s+/.exec(rest))) human = true;
          else if (
            id == null &&
            (t = new RegExp(`^#(${ID_PATTERN})\\s+`).exec(rest))
          )
            id = t[1];
          else break;
          rest = rest.slice(t[0].length);
        }
        last = { id, checked: im[1].toLowerCase() === "x", human, hasEvidence: false };
        criteria.push(last);
        if (id) ids.push(id);
      } else if (last && /^\s{2,}evidence:\s*\S/i.test(line)) {
        last.hasEvidence = true;
        hasEvidence = true;
      }
      continue;
    }

    if (mode === "runrecord") {
      const dm = DEVIATION.exec(line);
      if (dm) deviations.push({ id: dm[1], text: dm[2], phase });
    }
  }

  const ticks = { derived: 0, asserted: 0, human: 0 };
  const byId = new Map(criteria.filter((c) => c.id).map((c) => [c.id!, c]));
  for (const c of criteria) {
    if (!c.checked) continue;
    if (c.human) ticks.human++;
    else if (c.hasEvidence) ticks.derived++;
    else ticks.asserted++;
  }

  const danglingProbes = [...new Set(probeRefs)].filter((ref) => {
    const c = byId.get(ref);
    return !c || !c.checked;
  });

  const seen = new Map<string, number>();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  const duplicateIds = [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id);

  const phases = parsePhases(md);
  const gatesGreen =
    phases.length > 0 && phases.every((p) => p.total === 0 || p.done);
  const postRun = gatesGreen && (hasRunrecord || hasEvidence);

  return { postRun, deviations, ticks, danglingProbes, duplicateIds };
}
