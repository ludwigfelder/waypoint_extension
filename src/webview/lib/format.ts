// Small presentational helpers shared by the comment margin + cards.

// Annotation colors, cycled per comment (orange / indigo / green) — matches the
// "Plan Review" design's COMMENT_COLORS.
export const COMMENT_COLORS = ["#FF6A00", "#534AB7", "#0F6E56"];

export function commentColor(index: number): string {
  return COMMENT_COLORS[index % COMMENT_COLORS.length];
}

/** Compact relative time, e.g. "now", "3m", "2h", "4d". */
export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h";
  const d = Math.round(h / 24);
  return d + "d";
}

export const planTitle = (name: string) => name.replace(/\.md$/, "");
