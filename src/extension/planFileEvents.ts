// Which interaction event a plan-file change should produce.
//
// The watcher's create-versus-change classification cannot be trusted: it
// reflects how the writing tool happened to touch the inode, not what happened
// to the plan. An agent that rewrites a plan atomically (write-temp + rename,
// or delete + recreate) produces a *create* for a plan that already exists, and
// the tracker's once-per-plan `plan_created` guard then swallows it — so a
// send-back regeneration logged nothing at all, and the "v2 finished"
// timestamp was lost.
//
// So decide from durable facts instead: whether this plan has ever been
// recorded as created, and whether its mtime advanced. Pure and DOM-free, so
// the rule is testable without VS Code.

export type PlanFileOutcome = "created" | "updated" | "none";

/**
 * `seenCreated` — a `plan_created` for this plan already exists in the log.
 * `lastMtimeMs` — the mtime this session last logged for it, if any.
 * `mtimeMs` — the mtime just read from disk.
 *
 * A plan never recorded as created is a creation, whatever its mtime. After
 * that, only a forward step in mtime is an update: a duplicate watcher event
 * for a write already logged reports the same mtime and must stay silent.
 */
export function reconcilePlanFile(
  seenCreated: boolean,
  lastMtimeMs: number | undefined,
  mtimeMs: number,
): PlanFileOutcome {
  if (!seenCreated) return "created";
  return mtimeMs > (lastMtimeMs ?? 0) ? "updated" : "none";
}

/** The tracker surface this needs — narrower than the tracker itself. */
export interface PlanEventSink {
  hasCreated(plan: string): boolean;
  planCreated(plan: string, version: number, mtimeMs: number): Promise<void>;
  planUpdated(plan: string, version: number, mtimeMs: number): Promise<void>;
}

/**
 * Decide and emit, advancing `lastMtime` only when something was logged. Lives
 * here rather than in the host so the whole rule — not just its arithmetic —
 * is exercised by tests that cannot import `vscode`.
 */
export async function recordPlanFileEvent(
  sink: PlanEventSink,
  lastMtime: Map<string, number>,
  plan: string,
  version: number,
  mtimeMs: number,
): Promise<PlanFileOutcome> {
  const outcome = reconcilePlanFile(
    sink.hasCreated(plan),
    lastMtime.get(plan),
    mtimeMs,
  );
  if (outcome === "none") return outcome;
  lastMtime.set(plan, mtimeMs);
  if (outcome === "created") await sink.planCreated(plan, version, mtimeMs);
  else await sink.planUpdated(plan, version, mtimeMs);
  return outcome;
}
