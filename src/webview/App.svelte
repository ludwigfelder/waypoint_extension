<script lang="ts">
  import { onMount, tick } from "svelte";
  import Header from "./components/Header.svelte";
  import PlanDocument from "./components/PlanDocument.svelte";
  import DiffDocument from "./components/DiffDocument.svelte";
  import Toast from "./components/Toast.svelte";
  import PhaseProgress from "./components/PhaseProgress.svelte";
  import {
    listPlans,
    listVersions,
    getVersion,
    implementPlan,
    reflectPlan,
    setViewedPlan,
    trackInteraction,
    setFocus,
    addCriterion,
    removeCriterion,
    setCriterion,
    editPlanText,
    getBaseline,
    kitStatus,
    installKit,
    reinstallKit,
    resolveRefs,
    openRef,
    type Plan,
    type VersionInfo,
  } from "./lib/api";
  import { onEvent as onHostMessage } from "./lib/bridge";
  import type { ReopenSource, ClientInteraction } from "../shared/interactionLog";
  import Button from "./components/Button.svelte";
  import { saveComments, sendReview, type Comment } from "./lib/comments";
  import {
    applyVerdict,
    isVerdict,
    shiftComments,
    type CalloutVerdict,
    type TextShift,
  } from "../shared/review";
  import { diffPlanEdits } from "../shared/planEdits";
  import type { EntryAnchor } from "./lib/calloutFeedback";
  import { parsePhases } from "./lib/phases";
  import { connect, type PlanEvent } from "./lib/events";
  import type { ReadingAnchor } from "./lib/reading";

  let plans = $state<Plan[]>([]);
  let selected = $state<string | null>(null);
  let markdown = $state("");
  let loading = $state(false);

  let comments = $state<Comment[]>([]);
  let activeId = $state<string | null>(null);
  // Bodied comments and bare callout verdicts share the store but are counted
  // separately in the UI.
  const commentCount = $derived(comments.filter((c) => c.body).length);

  // Versioning: comments belong to one plan + one version. Sealed (past)
  // versions are read-only and their comments show as resolved.
  let versions = $state<VersionInfo[]>([]);
  let version = $state(1);
  let isCurrent = $state(true);
  // Why the viewed (sealed) version was superseded; "" on the live version.
  let versionNote = $state("");

  let theme = $state<"light" | "dark">("light");
  let status = $state<"review" | "accepted">("review");
  // Partial accept: implement only phases 1..acceptedUpTo (session state).
  let acceptedUpTo = $state<number | null>(null);
  const phases = $derived(parsePhases(markdown));

  // Inline redline diff of the current version against its predecessor.
  let diffView = $state(false);
  let previousMarkdown = $state("");
  /** The version `previousMarkdown` is the predecessor of; 0 when unloaded. */
  let prevFor = $state(0);
  const canDiff = $derived(version > 1);

  // Repo setup: how many kit files (skills + slash commands) this workspace is
  // missing. Non-zero shows the install banner — /waypoint has nothing to
  // invoke in this repo until the kit is installed.
  let kitMissing = $state(0);
  let installingKit = $state(false);

  // Plan document instance (absent in diff view) — the phase pills scroll
  // through its exported scrollToHeading.
  type DocHandle = {
    scrollToHeading?: (title: string) => void;
    anchor?: () => ReadingAnchor | null;
    restore?: (a: ReadingAnchor | null) => boolean;
  };
  let planDoc = $state<DocHandle>();
  let diffDoc = $state<DocHandle>();

  let sending = $state(false);
  // The plan whose rewrite we are waiting on, or null. Host-owned: it is set by
  // the `regenerating` message and cleared by `regenerated`, never by sendBack,
  // so the spinner cannot outlive the wait it represents.
  let regenerating = $state<string | null>(null);
  const isRegenerating = $derived(regenerating != null && regenerating === selected);
  let toast = $state("");
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function showToast(msg: string) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 3000);
  }

  /**
   * The trigger as typed, short enough for a toast. Codex's forms carry the plan
   * name and phase cap as trailing prose, so quoting the whole thing would run
   * off the end; the leading token is the part the reviewer is looking for.
   */
  function shortCommand(command: string | undefined, fallback: string): string {
    if (!command) return fallback;
    return command.length <= 44 ? command : `${command.slice(0, 44).trimEnd()}…`;
  }

  async function select(name: string, trigger: "auto_open" | "selection" | "reload" = "selection") {
    selected = name;
    status = "review";
    acceptedUpTo = null;
    try {
      versions = await listVersions(name);
      const cur = versions.find((v) => v.current)?.n ?? 1;
      await loadVersion(name, cur, trigger);
    } catch {
      markdown = `# Could not load \`${name}\``;
      comments = [];
    }
  }

  async function loadVersion(
    name: string,
    n: number,
    trigger: "auto_open" | "selection" | "reload" = "selection",
    silent = false,
  ) {
    // A silent refresh (file watcher after a write-through or agent tick)
    // re-renders the same document in place: skipping the loading swap keeps
    // the <main> element — and with it the scroll position — alive.
    if (!silent) {
      loading = true;
      activeId = null;
      // A diff is only meaningful for the version it was opened on; reset on
      // any plan/version navigation so the toggle's meaning stays tied to the
      // view.
      diffView = false;
    }
    try {
      const doc = await getVersion(name, n);
      markdown = doc.markdown;
      comments = doc.comments;
      version = doc.version;
      isCurrent = doc.current;
      versionNote = doc.note ?? "";
      // Warm the redline's other side while the reader is still reading this
      // one — toggling diff should not start a round trip.
      void ensurePrevious(name, doc.version);
      // Only the live version carries an edit baseline; sealed history is
      // already a fixed record and renders plain.
      baseline = doc.current ? await getBaseline(name) : "";
      await setViewedPlan(name, doc.version, trigger);
    } finally {
      if (!silent) loading = false;
    }
  }

  // UI-only interactions funnel through here (and PlanDocument's onUiEvent):
  // fire-and-forget, stamped with the viewed version.
  function uiEvent(i: ClientInteraction) {
    if (selected) void trackInteraction(selected, i, version);
  }

  // Follow a file reference in the plan into the editor group left of it. The
  // host logs the event (it holds the hash of the path), so no uiEvent here.
  function openFileRef(path: string, line?: number) {
    if (selected) void openRef(selected, path, line);
  }

  /**
   * Fetch the predecessor this version is redlined against. Called in the
   * background on load so the toggle has nothing left to wait for; `prevFor`
   * records which version the text belongs to, so a stale predecessor is never
   * diffed against a newer plan.
   */
  async function ensurePrevious(name: string, n: number) {
    if (n <= 1 || prevFor === n) return;
    try {
      const prev = await getVersion(name, n - 1);
      // A plan or version switch may have landed while this was in flight.
      if (selected === name && version === n) {
        previousMarkdown = prev.markdown;
        prevFor = n;
      }
    } catch {
      // No predecessor to read; the toggle stays available and shows nothing
      // to compare rather than failing.
    }
  }

  async function toggleDiff() {
    if (!canDiff || !selected) return;
    // Normally already prefetched, so this returns without awaiting anything.
    if (!diffView && prevFor !== version) await ensurePrevious(selected, version);
    // The two views are separate components with separate scrollers, so the
    // incoming one mounts at the top. Carry the reader's place across.
    const place = (diffView ? diffDoc : planDoc)?.anchor?.() ?? null;
    diffView = !diffView;
    uiEvent({ type: "diff_view_toggled", visible: diffView });
    await tick();
    // One frame later: the redline's own effects (highlighting, diagrams) run
    // after mount and can still move the text under a restored offset.
    requestAnimationFrame(() => (diffView ? diffDoc : planDoc)?.restore?.(place));
  }

  function selectVersion(n: number) {
    if (selected) loadVersion(selected, n);
  }

  async function addComment(d: {
    quote: string;
    start: number;
    end: number;
    body: string;
    crossCutting?: boolean;
  }) {
    if (!selected || !isCurrent) return;
    const c: Comment = {
      id: crypto.randomUUID(),
      quote: d.quote,
      start: d.start,
      end: d.end,
      body: d.body,
      createdAt: Date.now(),
      ...(d.crossCutting ? { crossCutting: true } : {}),
    };
    comments = [...comments, c];
    await saveComments(selected, comments);
    await trackInteraction(selected, {
      type: "comment_created",
      commentId: c.id,
      commentCount: comments.length,
      commentCreatedAt: c.createdAt,
    });
    if (c.crossCutting)
      await trackInteraction(selected, {
        type: "cross_cutting_comment",
        commentId: c.id,
        commentCount: comments.length,
      });
  }

  async function setVerdict(d: EntryAnchor & { verdict: CalloutVerdict }) {
    if (!selected || !isCurrent) return;
    const res = applyVerdict(comments, d, crypto.randomUUID(), Date.now());
    comments = res.comments;
    await saveComments(selected, comments);
    await trackInteraction(selected, {
      type: "callout_verdict",
      calloutKey: d.callout,
      verdict: res.outcome === "cleared" ? "cleared" : d.verdict,
      verdictCount: comments.filter(isVerdict).length,
    });
  }

  async function deleteComment(id: string) {
    if (!selected || !isCurrent) return;
    const removed = comments.find((c) => c.id === id);
    comments = comments.filter((c) => c.id !== id);
    activeId = null;
    await saveComments(selected, comments);
    await trackInteraction(selected, {
      type: "comment_deleted",
      commentId: id,
      commentCount: comments.length,
      ...(removed ? { commentCreatedAt: removed.createdAt } : {}),
    });
  }

  // Checklist write-through — fire-and-forget: the plan-file watcher re-renders
  // the viewer from the file, replacing the optimistic DOM either way.
  function criterionAdded(d: { ord: number; text: string }) {
    if (selected && isCurrent) void addCriterion(selected, d.ord, d.text);
  }
  function criterionRemoved(d: { ord: number; text: string }) {
    if (selected && isCurrent) void removeCriterion(selected, d.ord, d.text);
  }
  function criterionSet(d: { ord: number; text: string; checked: boolean }) {
    if (selected && isCurrent) void setCriterion(selected, d.ord, d.text, d.checked);
  }

  /* ---------------- inline prose editing ---------------- *
   * Unlike the checklist write-through, an inline edit cannot ride the
   * watcher's echo: re-rendering would destroy the caret the reviewer is
   * typing at. So while a caret is in the document the refresh is held, and
   * the document is refreshed from the write's own result when it leaves.
   */
  let editingDoc = $state(false);
  let refreshHeld = false;
  // The plan as it stood when this round of edits began; "" until the first
  // edit. Non-empty makes the document render as a redline against it.
  let baseline = $state("");

  /**
   * The reviewer's direct changes to the plan file this round, split the way
   * the review file splits them. Derived from the same baseline the redline
   * renders against, so what the reviewer sees struck through is exactly what
   * the agent will be told about.
   */
  const planEdits = $derived(isCurrent ? diffPlanEdits(baseline, markdown) : []);

  // Anything the agent has not evaluated yet. Comments and verdicts sit in the
  // comments file; edits and gate changes are already in the plan but reach the
  // agent only when the review is sent — so all four light the Send back button.
  const pendingReview = $derived(
    isCurrent && (comments.length > 0 || planEdits.length > 0),
  );

  async function editText(s: {
    start: number;
    end: number;
    expected: string;
    text: string;
  }) {
    if (!selected || !isCurrent) return { ok: false, markdown };
    return editPlanText(selected, s.start, s.end, s.expected, s.text);
  }

  /**
   * Slide comment anchors across an inline edit. Fire-and-forget like the rest
   * of the write-through: if the save loses a race the comments file is
   * rewritten on the next change anyway.
   */
  function textShifted(d: TextShift) {
    if (!selected || !isCurrent || !comments.length) return;
    const next = shiftComments(comments, d);
    if (next.every((c, i) => c === comments[i])) return;
    comments = next;
    void saveComments(selected, comments);
  }

  async function editingChanged(active: boolean, md?: string) {
    editingDoc = active;
    if (active) return;
    if (md != null) markdown = md;
    // The first edit of a round creates the baseline host-side; picking it up
    // here is what makes the redline appear as the caret leaves the block.
    const next = selected && isCurrent ? await getBaseline(selected) : "";
    if (editingDoc) return; // a new edit began while that was in flight
    baseline = next;
    if (refreshHeld) {
      refreshHeld = false;
      await onEvent({ name: selected ?? "", mtimeMs: 0 });
    }
  }

  async function sendBack() {
    if (!selected || !isCurrent || sending) return;
    sending = true;
    try {
      const { path, injected, command } = await sendReview(selected);
      showToast(
        injected
          ? `Sent — running ${shortCommand(command, "the apply trigger")} in your terminal`
          : `Copied prompt + wrote ${path.split("/").pop()}`,
      );
      await select(selected); // reload: new sealed version + fresh current
    } catch {
      showToast("Failed to send — see console.");
    } finally {
      sending = false;
    }
  }

  async function accept(upTo?: number) {
    if (!selected) return;
    // A phase cap only makes sense with 2+ phases, clamped to 1..N-1 (a cap of
    // N is just a full accept).
    const upToPhase =
      upTo != null && phases.length >= 2
        ? Math.min(Math.max(1, Math.round(upTo)), phases.length - 1)
        : undefined;
    status = "accepted";
    acceptedUpTo = upToPhase ?? null;
    diffView = false;
    const suffix = upToPhase != null ? ` --up-to-phase ${upToPhase}` : "";
    try {
      const { injected, command } = await implementPlan(selected, upToPhase);
      showToast(
        injected
          ? `Plan accepted — running ${shortCommand(
              command,
              `the implement trigger${suffix}`,
            )} in your terminal`
          : `Plan accepted — run /waypoint-implement ${selected}${suffix} to start the agent`,
      );
    } catch {
      showToast("Plan accepted — could not reach the terminal");
    }
  }
  function reopen() {
    backToReview("user");
  }

  /**
   * Accepted is a statement about one version of the plan. When a new version
   * lands — every /waypoint-update seals one first — or the agent signals that
   * its update changed the plan, the statement lapses and the header offers
   * Accept plan again, so nobody has to click Reopen to get there.
   */
  function backToReview(source: ReopenSource) {
    if (status !== "accepted") return;
    status = "review";
    acceptedUpTo = null;
    showToast(
      source === "user" ? "Plan reopened for review" : "New version — back in review",
    );
    uiEvent({ type: "plan_reopened", source });
  }

  // "Reader focused on comment X": log only real comments, only on change —
  // deactivation (null) and draft ids stay out of the log.
  function activate(id: string | null) {
    if (id && id !== activeId && comments.some((c) => c.id === id))
      uiEvent({ type: "comment_focused", commentId: id });
    activeId = id;
  }

  function jumpToPhase(title: string) {
    planDoc?.scrollToHeading?.(title);
    const targetIndex = phases.findIndex((p) => p.title === title);
    if (targetIndex >= 0) uiEvent({ type: "nav_jump", source: "phase_pill", targetIndex });
  }

  // Fire drift_view_shown once per plan+version — the frame itself re-derives
  // on every render, but the log only cares about first exposure.
  const driftFired = new Set<string>();
  function driftShown(d: {
    deviationCount: number;
    assertedCount: number;
    danglingProbeCount: number;
    duplicateIdCount: number;
  }) {
    if (!selected || !isCurrent) return;
    const key = `${selected}:${version}`;
    if (driftFired.has(key)) return;
    driftFired.add(key);
    void trackInteraction(selected, { type: "drift_view_shown", ...d });
  }

  async function reflect() {
    if (!selected) return;
    try {
      const { injected } = await reflectPlan(selected);
      showToast(
        injected
          ? "Reflecting — running /waypoint-update in your terminal"
          : `Run /waypoint-update ${selected} to reconcile the remaining phases`,
      );
    } catch {
      showToast("Could not reach the terminal");
    }
  }

  async function refreshKit() {
    try {
      kitMissing = (await kitStatus()).missing.length;
    } catch {
      kitMissing = 0;
    }
  }

  async function installSkills() {
    installingKit = true;
    try {
      const res = await installKit();
      kitMissing = 0;
      showToast(
        res.installed.length
          ? `Installed ${res.installed.length} Waypoint skill files` +
              (res.gitignore === "unchanged" ? "" : " + .gitignore entries")
          : "Waypoint skills already installed",
      );
    } catch {
      showToast("Could not install the skills — see console.");
    } finally {
      installingKit = false;
    }
  }

  // Header-menu "Reinstall Waypoint": force-overwrite the kit files with the
  // bundled versions on demand (the extension also does this automatically on
  // open, but this lets you refresh without reopening the workspace).
  async function reinstallWaypoint() {
    try {
      const res = await reinstallKit();
      kitMissing = 0;
      showToast(`Reinstalled ${res.installed.length} Waypoint skill files`);
    } catch {
      showToast("Could not reinstall Waypoint — see console.");
    }
  }

  function toggleTheme() {
    theme = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("wp-theme", theme);
    } catch {}
  }

  // The chrome is always dark (root tokens); `theme` only drives the plan
  // card ([data-plan-theme] on the document, stamped by PlanDocument /
  // DiffDocument). Code blocks are ALWAYS dark cards in either card theme,
  // so a single hljs-dark stylesheet serves both.
  $effect(() => {
    let link = document.getElementById("hljs-theme") as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.id = "hljs-theme";
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
    if (!link.getAttribute("href")?.endsWith("hljs-dark.css")) {
      link.setAttribute("href", "hljs-dark.css");
    }
  });

  async function onEvent(e: PlanEvent | null) {
    // A caret is in the document — re-rendering now would swallow keystrokes.
    // The refresh is replayed the moment editing ends.
    if (editingDoc) {
      refreshHeld = true;
      return;
    }
    const before = new Set(plans.map((p) => p.name));
    plans = await listPlans();

    const appeared = plans.find((p) => !before.has(p.name));
    if (appeared) return select(appeared.name, "auto_open");

    if (e?.name && e.name === selected) {
      const wasCurrent = versions.find((v) => v.current)?.n ?? 0;
      versions = await listVersions(selected);
      const nowCurrent = versions.find((v) => v.current)?.n ?? 0;
      if (nowCurrent > wasCurrent) backToReview("new_version");
      // Only refresh the view if looking at the current version — don't yank the
      // user out of a history view they're reading. Same-version refreshes are
      // silent (in place, scroll preserved); a version bump (e.g. a review
      // seal) goes through the full load.
      if (isCurrent) {
        const cur = versions.find((v) => v.current)?.n ?? version;
        return loadVersion(selected, cur, "selection", cur === version);
      }
      return;
    }

    if (plans.length && !plans.some((p) => p.name === selected)) {
      return select(plans[0].name, "reload");
    }
  }

  onMount(() => {
    try {
      const t = localStorage.getItem("wp-theme");
      if (t === "dark" || t === "light") theme = t;
    } catch {}
    void refreshKit();
    const socket = connect(onEvent, (e) => {
      if (e.type === "regenerating") {
        regenerating = e.name;
        return;
      }
      if (e.type === "reopened") {
        if (e.name === selected) backToReview("agent_signal");
        return;
      }
      if (regenerating !== e.name) return;
      regenerating = null;
      if (e.abandoned)
        showToast("No new version arrived — the agent may have stopped.");
      else if (!e.changed)
        showToast("The agent read your review and made no changes.");
    });
    // A palette-driven install ("Waypoint: Install Agent Skills…") retires the
    // banner by pushing a fresh kit status.
    const offKit = onHostMessage((m) => {
      if (m.type === "kit") kitMissing = m.missing?.length ?? 0;
    });
    // Webview focus → host, deduped by last-sent value. The host only refines
    // its reading intervals with this; panel visibility stays authoritative.
    let lastFocus: boolean | null = null;
    const sendFocus = () => {
      const focused = document.hasFocus() && !document.hidden;
      if (focused === lastFocus) return;
      lastFocus = focused;
      void setFocus(focused);
    };
    window.addEventListener("focus", sendFocus);
    window.addEventListener("blur", sendFocus);
    document.addEventListener("visibilitychange", sendFocus);
    sendFocus();
    return () => {
      socket.close();
      offKit();
      window.removeEventListener("focus", sendFocus);
      window.removeEventListener("blur", sendFocus);
      document.removeEventListener("visibilitychange", sendFocus);
    };
  });
</script>

<div class="flex h-screen w-screen flex-col overflow-hidden bg-surface-page text-strong">
  <Header
    {plans}
    {selected}
    {theme}
    {status}
    {versions}
    {version}
    {isCurrent}
    {diffView}
    {canDiff}
    {commentCount}
    pending={pendingReview}
    regenerating={isRegenerating}
    onDismissRegenerating={() => (regenerating = null)}
    {phases}
    onSelectPlan={select}
    onSelectVersion={selectVersion}
    onToggleTheme={toggleTheme}
    onToggleDiff={toggleDiff}
    onSendBack={sendBack}
    onAccept={accept}
    onReopen={reopen}
    onReinstall={reinstallWaypoint}
  />

  {#if !isCurrent && versionNote}
    <!-- Reading history: say why this version was left behind, so the
         reader does not have to infer it from the diff to the next one. -->
    <div
      class="z-10 flex shrink-0 items-center gap-x-3 bg-surface-page px-4 py-2 shadow-[inset_0_-1px_0_var(--border-hairline)]"
    >
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-wp-indigo-800" aria-hidden="true"></span>
      <span class="min-w-0 flex-1 font-sans text-xs text-subtle">
        <span class="font-mono">v{version}</span> was superseded by
        <span class="font-mono">v{version + 1}</span>: {versionNote}
      </span>
    </div>
  {/if}

  {#if kitMissing > 0}
    <div
      class="z-10 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 bg-surface-page px-4 py-2 shadow-[inset_0_-1px_0_var(--border-hairline)]"
    >
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-wp-orange-500" aria-hidden="true"></span>
      <span class="min-w-0 flex-1 font-sans text-xs text-subtle">
        This repo doesn't have the Waypoint agent skills yet — /waypoint won't
        work here until they're installed (they'll be gitignored).
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={installingKit}
        onclick={installSkills}
      >
        {installingKit ? "Installing…" : "Install skills"}
      </Button>
    </div>
  {/if}

  <PhaseProgress
    {markdown}
    accepted={status === "accepted"}
    acceptedUpTo={isCurrent && status === "accepted" ? acceptedUpTo : null}
    onReflect={reflect}
    onDriftShown={driftShown}
    onJumpToPhase={jumpToPhase}
  />


  {#if diffView && canDiff}
    <DiffDocument bind:this={diffDoc} {markdown} {previousMarkdown} {loading} {theme} />
  {:else}
    <PlanDocument
      bind:this={planDoc}
      {markdown}
      {baseline}
      {loading}
      {comments}
      {activeId}
      {theme}
      readOnly={!isCurrent || isRegenerating}
      dimmed={isRegenerating}
      onAdd={addComment}
      onDelete={deleteComment}
      onActivate={activate}
      onVerdict={setVerdict}
      onAddCriterion={criterionAdded}
      onRemoveCriterion={criterionRemoved}
      onSetCriterion={criterionSet}
      onEditText={editText}
      onEditing={editingChanged}
      onTextShift={textShifted}
      onUiEvent={uiEvent}
      onResolveRefs={resolveRefs}
      onOpenRef={openFileRef}
    />
  {/if}
</div>

<Toast message={toast} />
