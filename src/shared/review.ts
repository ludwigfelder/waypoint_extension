// Shared by the server (writes the .review.md file) and the client (clipboard).
// Keep this DOM-free so it can be imported from server.ts.

import type { PlanEdit, PlanEditKind } from "./planEdits";

export type CalloutVerdict = "accept" | "reject";

export type Comment = {
  id: string;
  quote: string; // the highlighted text
  start: number; // char offset into the rendered text
  end: number;
  body: string; // the user's comment
  createdAt: number;
  resolved?: boolean; // true when the comment belongs to a sealed (past) version
  // Callout-verdict records (accept/reject on a reviewable callout entry)
  // reuse the Comment pipeline: persistence, sealing, and review compilation.
  kind?: "verdict";
  verdict?: CalloutVerdict;
  callout?: string; // entry key "<type>:<per-type ordinal>", e.g. "assumption:2"
  // A cross-cutting comment asks for a whole-plan revision pass, not a local
  // edit; compileReview gives these their own section with that instruction.
  crossCutting?: boolean;
  // The reviewer edited the text this comment was anchored to, so its quote no
  // longer matches the plan. Kept and shown muted rather than dropped — the
  // reviewer's words are never discarded on their behalf.
  stale?: boolean;
};

/** `note`: why a sealed version was superseded (absent on the live version). */
export type VersionInfo = { n: number; current: boolean; note?: string };

export const isVerdict = (c: Comment): boolean => c.kind === "verdict";

/** A reviewer's inline edit, in rendered-document text coordinates. */
export type TextShift = { at: number; removed: number; inserted: number };

/**
 * Re-anchor comments across an inline edit. Comment offsets are absolute
 * positions in the rendered document text, so text inserted or removed above a
 * comment slides it — without this every comment below an edit would silently
 * come to underline the wrong words.
 *
 * Comments the edit passed through keep their span but are flagged stale: the
 * words they were written about have changed, which the reviewer needs to see
 * rather than have decided for them. Pure — returns a new array.
 */
export function shiftComments(comments: Comment[], d: TextShift): Comment[] {
  const delta = d.inserted - d.removed;
  const editEnd = d.at + d.removed;
  return comments.map((c) => {
    if (c.end <= d.at) return c; // wholly above the edit
    if (c.start >= editEnd) return { ...c, start: c.start + delta, end: c.end + delta };
    const start = Math.min(c.start, d.at);
    const end = Math.max(start, c.end + delta, d.at + d.inserted);
    return { ...c, start, end, stale: true };
  });
}

/**
 * Upsert/toggle the verdict record for a callout entry: no record → create;
 * same verdict again → clear; other verdict → switch (re-anchoring to the
 * entry's current offsets). Pure — returns a new array.
 */
export function applyVerdict(
  comments: Comment[],
  d: { callout: string; verdict: CalloutVerdict; start: number; end: number; quote: string },
  id: string,
  now: number,
): { comments: Comment[]; outcome: "set" | "switched" | "cleared" } {
  const existing = comments.find((c) => isVerdict(c) && c.callout === d.callout);
  if (!existing) {
    const record: Comment = {
      id,
      quote: d.quote,
      start: d.start,
      end: d.end,
      body: "",
      createdAt: now,
      kind: "verdict",
      verdict: d.verdict,
      callout: d.callout,
    };
    return { comments: [...comments, record], outcome: "set" };
  }
  if (existing.verdict === d.verdict) {
    return { comments: comments.filter((c) => c !== existing), outcome: "cleared" };
  }
  return {
    comments: comments.map((c) =>
      c === existing
        ? { ...c, verdict: d.verdict, start: d.start, end: d.end, quote: d.quote }
        : c,
    ),
    outcome: "switched",
  };
}

/** What the agent should do with each verdict, per callout type. */
const VERDICT_GUIDANCE: Record<string, Record<CalloutVerdict, string>> = {
  assumption: {
    accept: "The reviewer confirmed this assumption; the plan may rely on it.",
    reject:
      "The reviewer says this assumption is wrong; revise the plan so it no longer depends on it.",
  },
  decision: {
    accept: "The reviewer approved this decision; keep it as decided.",
    reject:
      "The reviewer rejected this decision; reconsider it, propose an alternative, and update the sections that depend on it.",
  },
};

/** Quote a block of plan lines so the agent can see them verbatim. */
function quote(out: string[], lines: string[]) {
  for (const line of lines) out.push(`> ${line}`);
  out.push(``);
}

/**
 * Render the edits the reviewer made to the plan file itself. These are already
 * saved, which is exactly what makes them easy to misread: without this section
 * the agent sees a plan it does not remember writing and no reason for the
 * difference, and with a naive one it re-applies changes that are already in.
 */
function emitEdits(out: string[], edits: PlanEdit[], kind: PlanEditKind) {
  const subset = edits.filter((e) => e.kind === kind);
  if (!subset.length) return;
  const gate = kind === "criterion";
  out.push(
    gate ? `## Gate changes` : `## Direct plan edits`,
    ``,
    gate
      ? `The reviewer added or removed acceptance-gate criteria directly in the ` +
          `viewer. Every change below is ALREADY saved in the plan file. Keep each ` +
          `added criterion — if one is not yet checkable, make it checkable rather ` +
          `than dropping it — and do not restore a removed one.`
      : `The reviewer edited the plan text directly in the viewer. Every change ` +
          `below is ALREADY saved in the plan file: do not re-apply it and do not ` +
          `revert it. Read each one as a statement of intent, then revise whatever ` +
          `else in the plan must change to stay consistent with it — dependent ` +
          `phases, callouts, gates, and the Verification section.`,
    ``,
  );
  subset.forEach((e, i) => {
    const label = gate ? `Gate change ${i + 1}` : `Edit ${i + 1}`;
    out.push(`### ${label}${e.section ? ` — ${e.section}` : ""}`, ``);
    if (e.removed.length && e.added.length) {
      out.push(`Was:`, ``);
      quote(out, e.removed);
      out.push(`Now:`, ``);
      quote(out, e.added);
    } else if (e.added.length) {
      out.push(`Added:`, ``);
      quote(out, e.added);
    } else {
      out.push(`Removed:`, ``);
      quote(out, e.removed);
    }
  });
}

/**
 * Compile a review round into a single plan-refinement prompt: the reviewer's
 * highlights and comments, plus the edits they made to the plan file directly.
 */
export function compileReview(
  planName: string,
  comments: Comment[],
  edits: PlanEdit[] = [],
): string {
  const verdicts = comments.filter(isVerdict);
  const notes = comments.filter((c) => !isVerdict(c));
  const out: string[] = [
    `# Plan refinement request`,
    ``,
    `Refine the plan file \`${planName}\` using the review below. ` +
      (edits.length
        ? `It has two kinds of input: changes the reviewer already made to the ` +
          `plan file, and comments asking you to make changes. Apply the comments; ` +
          `for the already-made changes, reconcile the rest of the plan with them. `
        : ``) +
      `For each comment, revise the quoted section to address the feedback while ` +
      `keeping the rest of the plan intact.`,
    ``,
  ];

  emitEdits(out, edits, "prose");
  emitEdits(out, edits, "criterion");

  if (verdicts.length) {
    out.push(
      `## Callout verdicts`,
      ``,
      `The reviewer reacted to individual callout entries. Apply each verdict's ` +
        `instruction to the quoted entry and to whatever depends on it.`,
      ``,
    );
    verdicts.forEach((c) => {
      const type = c.callout?.split(":")[0] ?? "callout";
      const label = c.verdict === "accept" ? "Accepted" : "Rejected";
      out.push(`### ${label} ${type} (${c.callout})`, ``);
      for (const line of c.quote.split("\n")) out.push(`> ${line}`);
      const guidance =
        VERDICT_GUIDANCE[type]?.[c.verdict ?? "accept"] ??
        `The reviewer marked this callout as ${label.toLowerCase()}.`;
      out.push(``, guidance, ``);
    });
  }

  const cross = notes.filter((c) => c.crossCutting);
  const local = notes.filter((c) => !c.crossCutting);

  if (cross.length) {
    out.push(
      `## Cross-cutting comments`,
      ``,
      `Each comment below is cross-cutting: a whole-plan revision pass, not a ` +
        `local edit. Apply it everywhere it applies — not only to the quoted ` +
        `section — and end your summary by listing every section and ` +
        `callout/criterion ID the pass touched.`,
      ``,
    );
    cross.forEach((c, i) => {
      out.push(`### Cross-cutting comment ${i + 1}`, ``, `Highlighted section:`, ``);
      for (const line of c.quote.split("\n")) out.push(`> ${line}`);
      out.push(``, `Feedback: ${c.body}`, ``);
    });
  }

  local.forEach((c, i) => {
    out.push(`## Comment ${i + 1}`, ``, `Highlighted section:`, ``);
    for (const line of c.quote.split("\n")) out.push(`> ${line}`);
    out.push(``, `Feedback: ${c.body}`, ``);
  });

  return out.join("\n");
}
