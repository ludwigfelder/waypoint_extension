// Plan-card width, shared by PlanDocument (which resizes it) and DiffDocument
// (which mirrors it so toggling diff doesn't shift the card). The stored value
// is the card's outer width in px (border-box, so padding is included).

export const CARD_DEFAULT_W = 720;
export const CARD_MIN_W = 560;
export const CARD_MAX_W = 920;
const KEY = "wp-art-w";

export const clampCardWidth = (w: number): number =>
  Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, Math.round(w)));

export function loadCardWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(KEY) ?? "", 10);
    if (Number.isFinite(v)) return clampCardWidth(v);
  } catch {}
  return CARD_DEFAULT_W;
}

export function saveCardWidth(w: number): void {
  try {
    localStorage.setItem(KEY, String(clampCardWidth(w)));
  } catch {}
}
