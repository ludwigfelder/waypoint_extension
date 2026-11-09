/**
 * Line-based code-fence tracker shared by the plan parsers (container
 * tokenizer, parsePhases, drift). Feed lines in order; the returned function
 * reports whether the line is inert — a fence delimiter or fenced content —
 * so `:::` markers, phase headings, and checkboxes inside fenced examples
 * never reach the callers' own scanning.
 *
 * A fence opens on ``` or ~~~ (any indent, optional info string) and closes
 * only on a bare delimiter of the same character at least as long — so a
 * four-backtick fence safely contains three-backtick examples.
 */
export function makeFenceTracker(): (line: string) => boolean {
  let open: { ch: string; len: number } | null = null;
  return (line: string): boolean => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      const ch = m[1][0];
      const len = m[1].length;
      if (!open) open = { ch, len };
      else if (ch === open.ch && len >= open.len && /^\s*(?:`{3,}|~{3,})\s*$/.test(line))
        open = null;
      return true;
    }
    return open !== null;
  };
}
