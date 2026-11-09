import { randomUUID } from "node:crypto";
import type {
  ClientInteraction,
  HostInteraction,
  InteractionEvent,
  ViewEndReason,
  ViewStartTrigger,
} from "../shared/interactionLog";
import { InteractionLogger } from "./interactionLogger";

type ActiveView = {
  plan: string;
  version: number;
  sessionId: string;
  startedAt: number;
  focusedAccumMs: number;
  focusedSince: number | undefined;
};

/**
 * What a terminal send did. A bare boolean is the old shape (still accepted, and
 * what the tests pass); the object also carries which CLI we believed was
 * listening and the text we typed, which is what makes a bounced send-back
 * visible in the log rather than indistinguishable from a clean round.
 */
export type TerminalSend =
  | boolean
  | { injected: boolean; agent?: string; command?: string };

function sendFields(send: TerminalSend): {
  terminalInjected: boolean;
  agent?: string;
  command?: string;
} {
  if (typeof send === "boolean") return { terminalInjected: send };
  return {
    terminalInjected: send.injected,
    ...(send.agent ? { agent: send.agent } : {}),
    ...(send.command ? { command: send.command } : {}),
  };
}

export class InteractionTracker {
  private events: InteractionEvent[] = [];
  private selected: { plan: string; version: number } | undefined;
  private active: ActiveView | undefined;
  private visible = false;
  private focused = true;

  constructor(
    readonly logger: InteractionLogger,
    private readonly now: () => number = Date.now,
    private readonly id: () => string = randomUUID,
  ) {}

  async init(): Promise<void> {
    await this.logger.init();
    this.events = await this.logger.readAll();
  }

  private async emit(
    plan: string,
    version: number,
    input: Parameters<InteractionLogger["log"]>[2],
  ) {
    this.events.push(await this.logger.log(plan, version, input));
  }

  /**
   * Has this plan ever been recorded as created? The file-event reconciler asks
   * before deciding create-versus-update, since the watcher's own event kind
   * only reports how the writing tool touched the inode.
   */
  hasCreated(plan: string): boolean {
    return this.events.some(
      (event) => event.plan === plan && event.type === "plan_created",
    );
  }

  async planCreated(plan: string, version: number, mtimeMs: number) {
    // The caller decides; this stays as a backstop against a double create.
    if (this.hasCreated(plan)) return;
    await this.emit(plan, version, { type: "plan_created", mtimeMs });
  }

  async planUpdated(plan: string, version: number, mtimeMs: number) {
    await this.emit(plan, version, { type: "plan_updated", mtimeMs });
  }

  /**
   * The answer to a `review_sent`: the agent's rewrite has landed and settled.
   * `reviewSentToDoneMs` is measured from this plan's most recent `review_sent`
   * — the analysis wants the round's turnaround, which nothing else records.
   */
  async regenerationFinished(
    plan: string,
    version: number,
    mtimeMs: number,
    outcome: { abandoned?: boolean; signalled?: boolean; changed?: boolean } = {},
  ) {
    const sent = [...this.events]
      .reverse()
      .find((event) => event.plan === plan && event.type === "review_sent");
    const sentAt = sent ? Date.parse(sent.timestamp) : NaN;
    await this.emit(plan, version, {
      type: "regeneration_finished",
      mtimeMs,
      reviewSentToDoneMs: Number.isFinite(sentAt)
        ? Math.max(0, this.now() - sentAt)
        : 0,
      abandoned: outcome.abandoned ?? false,
      signalled: outcome.signalled ?? false,
      // A timer-inferred finish only fires after a write, so it did change the
      // plan; an abandoned wait saw no write at all.
      changed: outcome.changed ?? !(outcome.abandoned ?? false),
    });
  }

  async ensurePlanBaseline(plan: string, version: number, mtimeMs: number) {
    if (this.hasCreated(plan)) return;
    await this.emit(plan, version, { type: "plan_created", mtimeMs, inferred: true });
  }

  async selectPlan(
    plan: string,
    version: number,
    trigger: ViewStartTrigger,
    baselineMtimeMs: number,
  ) {
    await this.ensurePlanBaseline(plan, version, baselineMtimeMs);
    if (this.selected?.plan === plan && this.selected.version === version) return;
    await this.endView("selection_changed");
    this.selected = { plan, version };
    if (this.visible) await this.startView(trigger);
  }

  async setVisible(visible: boolean) {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) await this.startView("panel_visible");
    else await this.endView("panel_hidden");
  }

  async dispose() {
    this.visible = false;
    await this.endView("panel_disposed");
    this.selected = undefined;
  }

  async endView(reason: ViewEndReason) {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    const now = this.now();
    await this.emit(active.plan, active.version, {
      type: "plan_view_ended",
      sessionId: active.sessionId,
      reason,
      durationMs: Math.max(0, now - active.startedAt),
      focusedMs: this.focusedMsOf(active, now),
    });
  }

  /** End the open view synchronously — the deactivate() path cannot await. */
  flushSync() {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    const now = this.now();
    this.events.push(
      this.logger.logSync(active.plan, active.version, {
        type: "plan_view_ended",
        sessionId: active.sessionId,
        reason: "window_closed",
        durationMs: Math.max(0, now - active.startedAt),
        focusedMs: this.focusedMsOf(active, now),
      }),
    );
  }

  /**
   * Webview focus refines the active interval; panel visibility still owns
   * interval boundaries. Unknown focus counts as focused (old logs degrade
   * to focusedMs === durationMs).
   */
  async setFocus(focused: boolean) {
    if (focused === this.focused) return;
    this.focused = focused;
    const active = this.active;
    if (!active) return;
    const now = this.now();
    if (focused) {
      active.focusedSince = now;
    } else {
      if (active.focusedSince != null)
        active.focusedAccumMs += Math.max(0, now - active.focusedSince);
      active.focusedSince = undefined;
    }
    await this.emit(active.plan, active.version, { type: "webview_focus", focused });
  }

  private focusedMsOf(active: ActiveView, now: number): number {
    return (
      active.focusedAccumMs +
      (active.focusedSince != null ? Math.max(0, now - active.focusedSince) : 0)
    );
  }

  private async startView(trigger: ViewStartTrigger) {
    if (!this.visible || !this.selected || this.active) return;
    const sessionId = this.id();
    const startedAt = this.now();
    this.active = {
      ...this.selected,
      sessionId,
      startedAt,
      focusedAccumMs: 0,
      focusedSince: this.focused ? startedAt : undefined,
    };
    await this.emit(this.selected.plan, this.selected.version, {
      type: "plan_view_started",
      sessionId,
      trigger,
    });
  }

  snapshot(): readonly InteractionEvent[] {
    return this.events;
  }

  async trackClientInteraction(
    plan: string,
    version: number,
    interaction: ClientInteraction | HostInteraction,
  ) {
    await this.emit(plan, version, interaction);
  }

  async reviewSent(
    plan: string,
    iteration: number,
    comments: Array<{ createdAt: number }>,
    send: TerminalSend,
    // The reviewer's direct changes to the plan file, which reach the agent
    // through the same review file as the comments.
    edits: { editCount: number; gateChangeCount: number } = {
      editCount: 0,
      gateChangeCount: 0,
    },
  ) {
    await this.endView("send_back");
    const now = this.now();
    const metrics = this.metrics(plan, now);
    const commentTimes = comments.map((comment) => comment.createdAt).sort((a, b) => a - b);
    await this.emit(plan, iteration, {
      type: "review_sent",
      iteration,
      commentCount: comments.length,
      creationToActionMs: Math.max(0, now - metrics.createdAt),
      latestUpdateToActionMs: Math.max(0, now - metrics.latestUpdateAt),
      activeReadingMs: metrics.activeReadingMs,
      ...(metrics.firstViewAt != null && commentTimes.length
        ? { firstViewToFirstCommentMs: Math.max(0, commentTimes[0] - metrics.firstViewAt) }
        : {}),
      ...(commentTimes.length
        ? { commentSpanMs: commentTimes[commentTimes.length - 1] - commentTimes[0] }
        : {}),
      ...sendFields(send),
      editCount: edits.editCount,
      gateChangeCount: edits.gateChangeCount,
    });
  }

  async planAccepted(
    plan: string,
    version: number,
    iterationCount: number,
    send: TerminalSend,
    upToPhase?: number,
  ) {
    const now = this.now();
    const metrics = this.metrics(plan, now, true);
    await this.emit(plan, version, {
      type: "plan_accepted",
      iterationCount,
      creationToActionMs: Math.max(0, now - metrics.createdAt),
      activeReadingMs: metrics.activeReadingMs,
      ...sendFields(send),
      ...(upToPhase != null ? { upToPhase } : {}),
    });
  }

  private metrics(plan: string, now: number, includeActive = false) {
    const events = this.events.filter((event) => event.plan === plan);
    const created = events.find((event) => event.type === "plan_created") as
      | Extract<InteractionEvent, { type: "plan_created" }>
      | undefined;
    const updates = events.filter((event) => event.type === "plan_updated") as Array<
      Extract<InteractionEvent, { type: "plan_updated" }>
    >;
    const ended = events.filter((event) => event.type === "plan_view_ended") as Array<
      Extract<InteractionEvent, { type: "plan_view_ended" }>
    >;
    const firstView = events.find((event) => event.type === "plan_view_started");
    const createdAt = created?.mtimeMs ?? now;
    const latestUpdateAt = updates.length ? updates[updates.length - 1].mtimeMs : createdAt;
    const activeExtra = includeActive && this.active?.plan === plan
      ? this.focusedMsOf(this.active, now)
      : 0;
    return {
      createdAt,
      latestUpdateAt,
      firstViewAt: firstView ? Date.parse(firstView.timestamp) : undefined,
      activeReadingMs:
        ended.reduce((total, event) => total + (event.focusedMs ?? event.durationMs), 0) +
        activeExtra,
    };
  }
}
