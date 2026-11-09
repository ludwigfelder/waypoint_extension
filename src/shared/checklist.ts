// The `:::checklist` grammar, in one place.
//
// A gate criterion may wrap across several source lines — plans are
// hard-wrapped, and the authoring skill itself writes wrapped criteria with
// indented continuation lines. Reading only the opening line drops the rest of
// the sentence, which is what made acceptance gates look truncated in the
// viewer.
//
// Both readers of this grammar share the scanner: the renderer
// (`src/webview/lib/markdown.ts`) and the checklist write-through
// (`src/extension/planStore.ts`), so what the viewer shows and what an edit
// addresses can never disagree.
//
// DOM-free and dependency-free, like `src/shared/planEdits.ts`.

export type ChecklistNoteKind = "override" | "evidence";

export type ChecklistNote = { kind: ChecklistNoteKind; text: string };

export type ScannedCriterion = {
  /** 0-based index of the `- [ ]` line within the scanned body. */
  lineStart: number;
  /** Lines the criterion text occupies: 1 plus its continuation lines. */
  lineSpan: number;
  /** Contiguous note lines directly below the span. */
  noteSpan: number;
  checked: boolean;
  /** The criterion text, continuation lines joined with single spaces. */
  raw: string;
  /** Column on the opening line where `raw` starts (after `- [x] `). */
  rawCol: number;
  /** Exclusive column on the span's last line where the text ends. */
  endCol: number;
  notes: ChecklistNote[];
};

/** A criterion's opening line. Captures its prefix, tick state, and text. */
const ITEM = /^(\s*-\s*\[([ xX])\]\s+)(.*\S)[ \t]*$/;
/** An implementer-written `override:` / `evidence:` line under a criterion. */
const NOTE = /^\s{2,}(override|evidence):\s*(\S.*?)[ \t]*$/i;
/** Indented, non-blank, and neither a note nor a new criterion. */
const CONTINUES = /^\s{2,}\S/;

/**
 * Scan a `:::checklist` body into its criteria. Lines that match nothing are
 * dropped, as they always were — the grammar stays closed.
 */
export function scanChecklist(body: string): ScannedCriterion[] {
  const lines = body.split("\n");
  const out: ScannedCriterion[] = [];
  let current: ScannedCriterion | null = null;
  // Continuation lines may only follow the criterion text itself. Once a note
  // or a blank line intervenes, the sentence is over.
  let wrapping = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const im = ITEM.exec(line);
    if (im) {
      current = {
        lineStart: i,
        lineSpan: 1,
        noteSpan: 0,
        checked: im[2].toLowerCase() === "x",
        raw: im[3],
        rawCol: im[1].length,
        endCol: im[1].length + im[3].length,
        notes: [],
      };
      out.push(current);
      wrapping = true;
      continue;
    }
    if (!current) continue;
    const nm = NOTE.exec(line);
    if (nm) {
      current.notes.push({
        kind: nm[1].toLowerCase() as ChecklistNoteKind,
        text: nm[2],
      });
      // Only a contiguous run counts for the span: `remove` splices by it, and
      // splicing across an intervening line would take that line with it.
      if (i === current.lineStart + current.lineSpan + current.noteSpan)
        current.noteSpan++;
      wrapping = false;
      continue;
    }
    if (wrapping && CONTINUES.test(line)) {
      const indent = line.length - line.trimStart().length;
      const text = line.slice(indent).trimEnd();
      current.raw += " " + text;
      current.lineSpan++;
      current.endCol = indent + text.length;
      continue;
    }
    wrapping = false;
  }
  return out;
}
