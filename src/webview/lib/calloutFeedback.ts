// Inline reject / comment feedback on reviewable callout entries
// (`.wp-callout-entry[data-callout]`, emitted by markdown.ts).
//
// Load-bearing rule: everything injected here must contribute NO text to the
// document — comment anchors are character offsets into docEl.textContent, so
// buttons are SVG-only and the verdict badge's visible glyph is CSS generated
// content (`::after`), which is not part of textContent.
import type { CalloutVerdict, Comment } from "../../shared/review";
import { isVerdict } from "../../shared/review";

export type EntryAnchor = {
  callout: string; // "<type>:<id>" key when the entry has a stable ID, else "<type>:<ord>"
  start: number;
  end: number;
  quote: string;
};

const svg = (path: string, width = 1.8) =>
  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

const ICONS: Record<string, string> = {
  reject: svg("M6 6l8 8M14 6l-8 8"),
  comment: svg(
    "M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v6A1.5 1.5 0 0 1 15.5 13H8l-3.5 3v-3H4.5A1.5 1.5 0 0 1 3 11.5v-6Z",
    1.6,
  ),
};

// Reject and comment only: silence is the reviewer's assent, so an explicit
// accept button earned no signal worth the third control. Stored `accept`
// verdicts from earlier rounds still bind and still render their badge.
const ACTIONS: Array<{ act: CalloutVerdict | "comment"; label: string }> = [
  { act: "reject", label: "Reject" },
  { act: "comment", label: "Comment on this" },
];

/**
 * An entry's verdict keys: `primary` is ID-based (`assumption:A3`) when the
 * entry carries a stable ID, else ordinal (`assumption:2`); `fallback` is the
 * ordinal key of an ID'd entry, so verdicts stored before a plan gained IDs
 * keep binding. New verdicts always store the primary key. IDs are
 * letter-leading and ordinals numeric, so the two never collide.
 */
function keysOf(entry: Element): { primary: string; fallback?: string } | null {
  const type = entry.getAttribute("data-callout");
  const ord = entry.getAttribute("data-callout-ord");
  if (!type || !ord) return null;
  const id = entry.getAttribute("data-callout-id");
  return id
    ? { primary: `${type}:${id}`, fallback: `${type}:${ord}` }
    : { primary: `${type}:${ord}` };
}

const reviewableEntries = (docEl: HTMLElement) =>
  [...docEl.querySelectorAll(".wp-callout-entry[data-callout]")] as HTMLElement[];

/** The entry's character range in docEl's rendered text, plus its key. */
export function entryAnchor(
  docEl: HTMLElement,
  entry: HTMLElement,
): EntryAnchor | null {
  const callout = keysOf(entry)?.primary;
  if (!callout) return null;
  const pre = document.createRange();
  pre.setStart(docEl, 0);
  pre.setEnd(entry, 0);
  const start = pre.toString().length;
  const quote = entry.textContent ?? "";
  return { callout, start, end: start + quote.length, quote };
}

/**
 * The zero-height anchor inside the entry's right rail that the verdict badge
 * and the hover actions overlay share — they occupy the same slot under the ID
 * badge, so revealing the actions on hover never reflows the entry. Created on
 * demand (and the rail with it, for entries markdown rendered without one).
 */
function railSlot(entry: HTMLElement): HTMLElement {
  let rail = entry.querySelector(":scope > .wp-entry-rail") as HTMLElement | null;
  if (!rail) {
    rail = document.createElement("div");
    rail.className = "wp-entry-rail";
    rail.setAttribute("data-keep", "1");
    entry.classList.add("has-rail");
    entry.appendChild(rail);
  }
  let slot = rail.querySelector(":scope > .wp-entry-slot") as HTMLElement | null;
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "wp-entry-slot";
    slot.setAttribute("data-keep", "1");
    rail.appendChild(slot);
  }
  return slot;
}

/**
 * Ensure each reviewable entry has its badge slot and (unless read-only) its
 * hover action buttons. Idempotent; re-run after every render.
 */
export function injectCalloutUI(docEl: HTMLElement, readOnly: boolean): void {
  for (const entry of reviewableEntries(docEl)) {
    if (!entry.querySelector(".wp-verdict")) {
      const badge = document.createElement("span");
      badge.className = "wp-verdict";
      badge.setAttribute("data-keep", "1");
      railSlot(entry).appendChild(badge);
    }
    if (!readOnly && !entry.querySelector(".wp-callout-actions")) {
      const box = document.createElement("div");
      box.className = "wp-callout-actions";
      box.setAttribute("data-keep", "1");
      for (const { act, label } of ACTIONS) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `wp-cal-btn wp-cal-${act}`;
        b.setAttribute("data-keep", "1");
        b.setAttribute("aria-label", label);
        b.title = label;
        b.innerHTML = ICONS[act];
        box.appendChild(b);
      }
      railSlot(entry).appendChild(box);
    }
  }
}

const normalize = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * Reflect stored verdict records onto the entries: badge + entry classes.
 * A record binds by callout key, then must match the entry's normalized text
 * against its stored quote — on mismatch (out-of-band plan edit shifted the
 * ordinals) no badge is shown rather than mislabeling a different entry.
 */
export function bindVerdicts(docEl: HTMLElement, comments: Comment[]): void {
  const byKey = new Map<string, Comment>();
  for (const c of comments) {
    if (isVerdict(c) && c.callout) byKey.set(c.callout, c);
  }
  for (const entry of reviewableEntries(docEl)) {
    const keys = keysOf(entry);
    const record = keys
      ? (byKey.get(keys.primary) ??
        (keys.fallback ? byKey.get(keys.fallback) : undefined))
      : undefined;
    const badge = entry.querySelector(".wp-verdict");
    const matches =
      record && normalize(entry.textContent ?? "") === normalize(record.quote);
    const verdict = matches ? record!.verdict : undefined;
    entry.classList.toggle("is-accepted", verdict === "accept");
    entry.classList.toggle("is-rejected", verdict === "reject");
    badge?.classList.toggle("wp-verdict--accept", verdict === "accept");
    badge?.classList.toggle("wp-verdict--reject", verdict === "reject");
    // The rail badge is a compact marker; its name lives in the tooltip (a
    // title attribute, never document text).
    if (badge) {
      const name =
        verdict === "accept" ? "Accepted" : verdict === "reject" ? "Rejected" : "";
      if (name) badge.setAttribute("title", name);
      else badge.removeAttribute("title");
    }
    entry
      .querySelector(".wp-cal-reject")
      ?.classList.toggle("active", verdict === "reject");
  }
}

/**
 * Delegated-click branch for the injected buttons. Returns true when the click
 * was one of ours (the caller should stop further handling).
 */
export function handleCalloutClick(
  e: MouseEvent,
  docEl: HTMLElement,
  cb: {
    onVerdict: (d: EntryAnchor & { verdict: CalloutVerdict }) => void;
    onComment: (a: EntryAnchor) => void;
  },
): boolean {
  const target = e.target as HTMLElement;
  const btn = target.closest?.(".wp-cal-btn") as HTMLElement | null;
  if (!btn || !docEl.contains(btn)) return false;
  const entry = btn.closest(".wp-callout-entry") as HTMLElement | null;
  const anchor = entry ? entryAnchor(docEl, entry) : null;
  if (!anchor) return true;
  if (btn.classList.contains("wp-cal-reject")) {
    cb.onVerdict({ ...anchor, verdict: "reject" });
  } else {
    cb.onComment(anchor);
  }
  return true;
}
