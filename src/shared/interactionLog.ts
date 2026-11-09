export const INTERACTION_LOG_SCHEMA_VERSION = 1 as const;

export type ViewStartTrigger =
  | "auto_open"
  | "selection"
  | "panel_visible"
  | "reload";
export type ViewEndReason =
  | "selection_changed"
  | "panel_hidden"
  | "panel_disposed"
  | "send_back"
  | "window_closed";

type EventBase = {
  schemaVersion: typeof INTERACTION_LOG_SCHEMA_VERSION;
  eventId: string;
  timestamp: string;
  plan: string;
  version: number;
};

export type InteractionEvent = EventBase &
  (
    | { type: "plan_created"; mtimeMs: number; inferred?: boolean }
    | { type: "plan_updated"; mtimeMs: number }
    // The agent's rewrite after a send-back has landed and gone quiet. This is
    // the "v2 finished" timestamp: `review_sent` marks the request, and until
    // now nothing marked the answer.
    | {
        type: "regeneration_finished";
        mtimeMs: number;
        reviewSentToDoneMs: number;
        /** True when the settle window never opened and the wait timed out. */
        abandoned: boolean;
        /** The agent said so, rather than a timer inferring it (#D10). */
        signalled: boolean;
        /** False when the run read the plan and correctly rewrote nothing. */
        changed: boolean;
      }
    | { type: "plan_view_started"; sessionId: string; trigger: ViewStartTrigger }
    | {
        type: "plan_view_ended";
        sessionId: string;
        reason: ViewEndReason;
        durationMs: number;
        focusedMs?: number;
      }
    | {
        type: "comment_created" | "comment_deleted";
        commentId: string;
        commentCount: number;
        commentCreatedAt?: number;
      }
    | {
        type: "callout_verdict";
        calloutKey: string;
        verdict: "accept" | "reject" | "cleared";
        verdictCount: number;
      }
    | { type: "cross_cutting_comment"; commentId: string; commentCount: number }
    | {
        type: "drift_view_shown";
        deviationCount: number;
        assertedCount: number;
        danglingProbeCount: number;
        duplicateIdCount: number;
      }
    | {
        type: "review_sent";
        iteration: number;
        commentCount: number;
        creationToActionMs: number;
        latestUpdateToActionMs: number;
        activeReadingMs: number;
        firstViewToFirstCommentMs?: number;
        commentSpanMs?: number;
        terminalInjected: boolean;
        // `terminalInjected` only means the text was typed — `sendText` cannot
        // report whether the CLI accepted it (#A7). These say which CLI we
        // believed was listening and what we typed, so a bounced round is
        // visible here instead of looking like a clean one.
        agent?: string;
        command?: string;
        // Direct changes to the plan file compiled into the same review:
        // prose hunks and gate criteria added/removed.
        editCount?: number;
        gateChangeCount?: number;
      }
    | {
        type: "plan_accepted";
        iterationCount: number;
        creationToActionMs: number;
        activeReadingMs: number;
        terminalInjected: boolean;
        agent?: string;
        command?: string;
        upToPhase?: number; // partial accept: implement only phases 1..N
      }
    | {
        type: "criterion_set";
        checklistOrd: number;
        criterionKey: string;
        isHuman: boolean;
        checked: boolean;
      }
    | {
        type: "criterion_added" | "criterion_removed";
        checklistOrd: number;
        criterionKey: string;
        isHuman: boolean;
        charCount: number;
      }
    | {
        type: "prose_edit";
        sourceStart: number;
        insertedChars: number;
        removedChars: number;
        flushCount: number;
        durationMs: number;
      }
    | {
        type: "reflect_requested";
        terminalInjected: boolean;
        agent?: string;
        command?: string;
      }
    // A reviewer followed a file reference in the plan into the editor.
    // `refKey` is a content-free hash of the path, as with criteria.
    | { type: "ref_opened"; refKey: string; hasLine: boolean }
    | { type: "diff_view_toggled"; visible: boolean }
    | { type: "nav_jump"; source: "phase_pill" | "outline"; targetIndex: number }
    | { type: "comment_focused"; commentId: string }
    | { type: "comment_draft_opened"; draftId: string; quoteLength: number }
    | { type: "comment_draft_cancelled"; draftId: string }
    | { type: "replan_modal"; action: "opened" | "cancelled" }
    | { type: "plan_reopened"; source?: ReopenSource }
    | { type: "card_resized"; widthPx: number; previousWidthPx: number }
    | { type: "webview_focus"; focused: boolean }
    | {
        type: "section_dwell";
        sectionCount: number;
        // `label` is the section's heading text — a deliberate, narrow
        // exception to the content-free rule (headings only, never body).
        dwells: Array<{ s: number; label: string; ms: number }>;
      }
  );

export type InteractionEventInput = InteractionEvent extends infer E
  ? E extends InteractionEvent
    ? Omit<E, keyof EventBase>
    : never
  : never;

/**
 * What put an accepted plan back in review: the reviewer's Reopen button, a
 * new version of the plan landing (every update seals one), or the update
 * skill's finished signal reaching the host.
 */
export type ReopenSource = "user" | "new_version" | "agent_signal";

export type ClientInteraction =
  | {
      type: "comment_created";
      commentId: string;
      commentCount: number;
      commentCreatedAt: number;
    }
  | {
      type: "comment_deleted";
      commentId: string;
      commentCount: number;
      commentCreatedAt?: number;
    }
  | {
      type: "callout_verdict";
      calloutKey: string;
      verdict: "accept" | "reject" | "cleared";
      verdictCount: number;
    }
  | { type: "cross_cutting_comment"; commentId: string; commentCount: number }
  | {
      type: "drift_view_shown";
      deviationCount: number;
      assertedCount: number;
      danglingProbeCount: number;
      duplicateIdCount: number;
    }
  | {
      type: "prose_edit";
      sourceStart: number;
      insertedChars: number;
      removedChars: number;
      flushCount: number;
      durationMs: number;
    }
  | { type: "diff_view_toggled"; visible: boolean }
  | { type: "nav_jump"; source: "phase_pill" | "outline"; targetIndex: number }
  | { type: "comment_focused"; commentId: string }
  | { type: "comment_draft_opened"; draftId: string; quoteLength: number }
  | { type: "comment_draft_cancelled"; draftId: string }
  | { type: "replan_modal"; action: "opened" | "cancelled" }
  | { type: "plan_reopened"; source?: ReopenSource }
  | { type: "card_resized"; widthPx: number; previousWidthPx: number }
  | {
      type: "section_dwell";
      sectionCount: number;
      dwells: Array<{ s: number; label: string; ms: number }>;
    };

/** Events the extension host builds itself (never sent by the webview). */
export type HostInteraction =
  | {
      type: "criterion_set";
      checklistOrd: number;
      criterionKey: string;
      isHuman: boolean;
      checked: boolean;
    }
  | {
      type: "criterion_added" | "criterion_removed";
      checklistOrd: number;
      criterionKey: string;
      isHuman: boolean;
      charCount: number;
    }
  | {
      type: "reflect_requested";
      terminalInjected: boolean;
      agent?: string;
      command?: string;
    }
  | { type: "ref_opened"; refKey: string; hasLine: boolean }
  | {
      type: "regeneration_finished";
      mtimeMs: number;
      reviewSentToDoneMs: number;
      abandoned: boolean;
      signalled: boolean;
      changed: boolean;
    };

const baseFields = ["schemaVersion", "eventId", "timestamp", "plan", "version"];
const fieldsByType: Record<InteractionEvent["type"], readonly string[]> = {
  plan_created: ["type", "mtimeMs", "inferred"],
  plan_updated: ["type", "mtimeMs"],
  regeneration_finished: [
    "type",
    "mtimeMs",
    "reviewSentToDoneMs",
    "abandoned",
    "signalled",
    "changed",
  ],
  plan_view_started: ["type", "sessionId", "trigger"],
  plan_view_ended: ["type", "sessionId", "reason", "durationMs", "focusedMs"],
  comment_created: ["type", "commentId", "commentCount", "commentCreatedAt"],
  comment_deleted: ["type", "commentId", "commentCount", "commentCreatedAt"],
  callout_verdict: ["type", "calloutKey", "verdict", "verdictCount"],
  cross_cutting_comment: ["type", "commentId", "commentCount"],
  drift_view_shown: [
    "type",
    "deviationCount",
    "assertedCount",
    "danglingProbeCount",
    "duplicateIdCount",
  ],
  review_sent: [
    "type",
    "iteration",
    "commentCount",
    "creationToActionMs",
    "latestUpdateToActionMs",
    "activeReadingMs",
    "firstViewToFirstCommentMs",
    "commentSpanMs",
    "terminalInjected",
    "agent",
    "command",
    "editCount",
    "gateChangeCount",
  ],
  plan_accepted: [
    "type",
    "iterationCount",
    "creationToActionMs",
    "activeReadingMs",
    "terminalInjected",
    "agent",
    "command",
    "upToPhase",
  ],
  criterion_set: ["type", "checklistOrd", "criterionKey", "isHuman", "checked"],
  criterion_added: ["type", "checklistOrd", "criterionKey", "isHuman", "charCount"],
  criterion_removed: ["type", "checklistOrd", "criterionKey", "isHuman", "charCount"],
  prose_edit: [
    "type",
    "sourceStart",
    "insertedChars",
    "removedChars",
    "flushCount",
    "durationMs",
  ],
  reflect_requested: ["type", "terminalInjected", "agent", "command"],
  ref_opened: ["type", "refKey", "hasLine"],
  diff_view_toggled: ["type", "visible"],
  nav_jump: ["type", "source", "targetIndex"],
  comment_focused: ["type", "commentId"],
  comment_draft_opened: ["type", "draftId", "quoteLength"],
  comment_draft_cancelled: ["type", "draftId"],
  replan_modal: ["type", "action"],
  plan_reopened: ["type", "source"],
  card_resized: ["type", "widthPx", "previousWidthPx"],
  webview_focus: ["type", "focused"],
  section_dwell: ["type", "sectionCount", "dwells"],
};

/** Runtime boundary: only explicitly enumerated metadata fields reach disk. */
export function assertInteractionEvent(value: unknown): asserts value is InteractionEvent {
  if (!value || typeof value !== "object") throw new Error("invalid interaction event");
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || !(type in fieldsByType)) {
    throw new Error("invalid interaction event type");
  }
  const allowed = new Set([...baseFields, ...fieldsByType[type as InteractionEvent["type"]]]);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`unexpected interaction fields: ${unexpected.join(", ")}`);
  if (
    record.schemaVersion !== INTERACTION_LOG_SCHEMA_VERSION ||
    typeof record.eventId !== "string" ||
    typeof record.timestamp !== "string" ||
    typeof record.plan !== "string" ||
    typeof record.version !== "number"
  ) {
    throw new Error("invalid interaction event metadata");
  }
}
