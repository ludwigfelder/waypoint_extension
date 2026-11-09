/**
 * Section-dwell accumulator for the reading-behavior log. Accrues engaged
 * time per section ordinal in memory and emits one batched `section_dwell`
 * payload at most every `flushMs` — plus immediately on disengage, so a
 * blurred window emits its pre-blur time once and then stays silent.
 *
 * A "pass" is one continuous stay in a section; passes shorter than `minMs`
 * (scrolling through) are dropped. A flush mid-pass commits the elapsed part
 * even when short — the pass is still ongoing, and dropping it would lose
 * real dwell across the flush boundary.
 */
export type DwellEntry = { s: number; label: string; ms: number };

export function createDwellTracker({
  flushMs = 15_000,
  minMs = 500,
  now = Date.now,
  onFlush,
}: {
  flushMs?: number;
  minMs?: number;
  now?: () => number;
  onFlush: (dwells: DwellEntry[], sectionCount: number) => void;
}) {
  const buckets = new Map<number, { label: string; ms: number }>();
  let section = -1;
  let sectionLabel = "";
  let sectionCount = 0;
  let since: number | null = null;
  let engaged = true;
  let timer: ReturnType<typeof setInterval> | null = null;

  function commitPass(keepShort: boolean) {
    if (since == null || section < 0) return;
    const ms = Math.max(0, now() - since);
    since = null;
    if (ms <= 0 || (ms < minMs && !keepShort)) return;
    const bucket = buckets.get(section);
    if (bucket) bucket.ms += ms;
    else buckets.set(section, { label: sectionLabel, ms });
  }

  function arm() {
    since = engaged && section >= 0 ? now() : null;
  }

  function emit() {
    if (!buckets.size) return;
    const dwells = [...buckets.entries()]
      .map(([s, { label, ms }]) => ({ s, label, ms }))
      .sort((a, b) => a.s - b.s);
    buckets.clear();
    onFlush(dwells, sectionCount);
  }

  function setSection(index: number, count: number, label: string) {
    sectionCount = count;
    if (index === section) {
      sectionLabel = label;
      return;
    }
    commitPass(false);
    section = index;
    sectionLabel = label;
    arm();
    if (timer == null) timer = setInterval(flush, flushMs);
  }

  function setEngaged(value: boolean) {
    if (value === engaged) return;
    engaged = value;
    if (value) {
      arm();
    } else {
      commitPass(false);
      since = null;
      emit();
    }
  }

  function flush() {
    commitPass(true);
    arm();
    emit();
  }

  function destroy() {
    flush();
    if (timer != null) clearInterval(timer);
    timer = null;
    since = null;
  }

  return { setSection, setEngaged, flush, destroy };
}
