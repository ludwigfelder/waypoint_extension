import { onEvent, request } from "./bridge";

export type PlanEvent = { type: "changed"; name: string; mtimeMs: number };

/** A plan sent back for revision, and the agent's rewrite landing (or not). */
export type RegenEvent =
  | { type: "regenerating"; name: string }
  | { type: "regenerated"; name: string; abandoned: boolean; changed: boolean }
  /** The agent's update signal: a new version of `name` awaits review. */
  | { type: "reopened"; name: string };

/**
 * Mirrors the old socket `connect()` API: `handler` fires on each "changed"
 * event from the host, and once with `null` on connect to trigger the initial
 * load. `onRegen` carries the send-back lifecycle, which is host-owned so the
 * spinner has exactly one source of truth.
 */
export function connect(
  handler: (e: PlanEvent | null) => void,
  onRegen?: (e: RegenEvent) => void,
) {
  const off = onEvent((m) => {
    if (m.type === "changed") handler(m as PlanEvent);
    else if (
      m.type === "regenerating" ||
      m.type === "regenerated" ||
      m.type === "reopened"
    )
      onRegen?.(m as RegenEvent);
  });
  // Tell the host we can hear it, and only once we can: auto-open posts its
  // first `changed` before this bundle exists, so the host holds those and
  // replays them in response to this. Sent after the listener is installed so
  // the replay cannot outrun it.
  void request("ready");
  queueMicrotask(() => handler(null));
  return { close: off };
}
