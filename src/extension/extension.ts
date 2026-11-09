import * as vscode from "vscode";
import { join } from "node:path";
import { readFile, rm, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { PlanStore } from "./planStore";
import { InteractionLogger } from "./interactionLogger";
import { InteractionTracker } from "./interactionTracker";
import { criterionKey, isHumanCriterion } from "./criterion";
import { recordPlanFileEvent } from "./planFileEvents";
import { isBareName, refKey, resolveDirect } from "./refs";
import { sendApply, sendImplement, sendUpdate } from "./terminal";
import { installKit, kitStatus, type KitInstallResult } from "./skillsKit";
import { waypointDirCandidates, pickWaypointDir } from "./waypointDir";

let panel: vscode.WebviewPanel | undefined;
/** In-flight `openPanel` call, so concurrent auto-opens build one panel. */
let opening: Promise<void> | undefined;
let store: PlanStore | undefined;
let tracker: InteractionTracker | undefined;
let watcher: vscode.FileSystemWatcher | undefined;
let signalWatcher: vscode.FileSystemWatcher | undefined;
let context: vscode.ExtensionContext;

export async function activate(ctx: vscode.ExtensionContext) {
  context = ctx;

  // Register the command unconditionally so it always exists, even with no
  // workspace open yet — the handler resolves the workspace lazily.
  ctx.subscriptions.push(
    vscode.commands.registerCommand("waypoint.open", () => openPanel()),
    vscode.commands.registerCommand("waypoint.installSkills", () =>
      installSkillsCommand(),
    ),
  );

  // If a workspace is already open, start watching now. Otherwise wait until one
  // is added (or until the command is first run).
  await ensureStore();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => ensureStore()),
  );
}

/** The agent kit bundled into the VSIX by build.ts (undotted dir names). */
function kitRoot(): string {
  return join(context.extensionUri.fsPath, "resources", "kit");
}

function installMessage(res: KitInstallResult): string {
  if (!res.installed.length)
    return "Waypoint: the agent skills are already installed in this repo.";
  const removed = res.removed.length
    ? `, removed ${res.removed.length} stale copies`
    : "";
  const gitignore =
    res.gitignore === "created"
      ? " and created .gitignore"
      : res.gitignore === "updated"
        ? " and updated .gitignore"
        : "";
  return `Waypoint: installed ${res.installed.length} agent skill files${removed}${gitignore}.`;
}

/** Palette fallback for the webview's "Install skills" button. */
async function installSkillsCommand() {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    vscode.window.showWarningMessage(
      "Waypoint: open the repo to install the agent skills into.",
    );
    return;
  }
  try {
    const res = await installKit(kitRoot(), ws.uri.fsPath, true, { removeLegacy: true });
    vscode.window.showInformationMessage(installMessage(res));
    // Retire the panel's setup banner without a reload.
    panel?.webview.postMessage({ type: "kit", missing: [] });
  } catch (err) {
    console.error("[waypoint] skill install failed:", err);
    vscode.window.showErrorMessage(
      "Waypoint: could not install the agent skills — see the extension host log.",
    );
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** See `waypointDir.ts`: `.waypoint`, else the pre-rename dirs, default `.waypoint`. */
async function resolveWaypointDir(wsPath: string): Promise<string> {
  const found = new Set<string>();
  for (const p of waypointDirCandidates(wsPath)) {
    if (await dirExists(p)) found.add(p);
  }
  return pickWaypointDir(wsPath, (p) => found.has(p));
}

/**
 * Lazily create the store + watcher for the first workspace folder.
 *
 * Only workspaces that already contain a `.waypoint` (or legacy `.galley`) dir are
 * touched on activation — `createIfMissing` is passed solely by the deliberate
 * entry point (opening the panel). Without this gate, every folder anyone
 * opened in VS Code got `.waypoint/`, a `.gitignore` edit, and a force-installed
 * kit — including home directories (Remote-SSH's default workspace, where the
 * skills then surface user-level in every session) and folders that must stay
 * pristine.
 */
async function ensureStore(createIfMissing = false): Promise<boolean> {
  if (store) return true;
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return false;

  const waypointDir = await resolveWaypointDir(ws.uri.fsPath);
  if (!createIfMissing && !(await dirExists(waypointDir))) return false;
  store = new PlanStore(waypointDir);
  await store.init();
  tracker = new InteractionTracker(new InteractionLogger(waypointDir));
  await tracker.init();

  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(store.plansDir, "*.md"),
  );
  // Create and change take the same path: the reconciler decides which event a
  // write is, from the log and the file's mtime, because the watcher's own
  // classification only reflects how the writing tool touched the inode.
  watcher.onDidCreate((uri) => {
    handleChange(uri);
    enqueuePlanFileEvent(uri);
  });
  watcher.onDidChange((uri) => {
    handleChange(uri);
    enqueuePlanFileEvent(uri);
  });
  watcher.onDidDelete((uri) => {
    // A rename window is not a deletion: drop the cached mtime so the recreate
    // that follows is compared against the log, not against a stale value.
    lastMtime.delete(uri.path.split("/").pop()!);
    handleChange(uri);
  });
  context.subscriptions.push(watcher);

  // The signal channel is its own watcher: the plan watcher above is scoped to
  // `plans/*.md` and non-recursive (#A9), so it cannot see these.
  signalWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(join(waypointDir, "signals"), "*.json"),
  );
  signalWatcher.onDidCreate((uri) => void handleSignal(uri));
  signalWatcher.onDidChange((uri) => void handleSignal(uri));
  context.subscriptions.push(signalWatcher);

  // Keep this repo's kit current: force-overwrite the skills with the bundled
  // versions on open, so an extension update reaches every initialized
  // workspace (the gate above) without a manual "Reinstall Waypoint".
  // Fire-and-forget — never block setup.
  void installKit(kitRoot(), ws.uri.fsPath, true)
    .then((res) => {
      if (res.installed.length)
        panel?.webview.postMessage({ type: "kit", missing: [] });
    })
    .catch((err) => console.error("[waypoint] kit auto-refresh failed:", err));

  return true;
}

/**
 * Changes that landed before the webview could hear them. Auto-open posts its
 * first `changed` ~120 ms after creating the panel, long before the bundle has
 * booted, so that message is dropped — the plan then appears only because the
 * webview happens to fetch on connect. These are replayed on `ready` instead.
 */
const pendingChanges = new Map<string, number>();
let webviewReady = false;

/** The mtime last logged for each plan, so a repeat event stays silent. */
const lastMtime = new Map<string, number>();

/**
 * Plans sent back for revision and still waiting on the agent's rewrite. The
 * viewer spins for exactly as long as an entry lives here.
 *
 * Regeneration counts as finished when the plan has been written at least once
 * since the send and has then been quiet for `SETTLE_MS` (#D4) — an agent
 * writes a plan in bursts, so the first write is a start, not an end. The
 * abandon timer is the floor: a spinner with no exit is worse than no spinner.
 */
type PendingReview = {
  /** The review file this round wrote, or "" for a Reflect (which writes none). */
  reviewPath: string;
  /** The version `sendReview` sealed — the stem the archive is filed under. */
  sealedVersion: number;
  settle?: ReturnType<typeof setTimeout>;
  abandon: ReturnType<typeof setTimeout>;
};
const pendingReview = new Map<string, PendingReview>();
const SETTLE_MS = 1_500;
// The floor, not the expected path: the agent's own signal normally ends the
// wait in seconds (#D10). Long enough to cover a slow first write, short enough
// that a missed signal is an annoyance rather than a dead panel.
const ABANDON_MS = 90_000;

function clearPending(name: string): PendingReview | undefined {
  const entry = pendingReview.get(name);
  if (!entry) return undefined;
  clearTimeout(entry.settle);
  clearTimeout(entry.abandon);
  pendingReview.delete(name);
  return entry;
}

/** Stop the spinner and log the round's turnaround. */
async function finishRegeneration(
  name: string,
  mtimeMs: number,
  outcome: { abandoned?: boolean; signalled?: boolean; changed?: boolean },
) {
  const entry = clearPending(name);
  if (!entry) return;
  // Retire the round's review file into the version it belongs to. This runs on
  // every exit — signal, settle, or abandon — because a round that changed
  // nothing still consumed its review. Only a path this session's `sendReview`
  // recorded is touched, never one derived from a plan name at settle time.
  if (entry.reviewPath) {
    try {
      await store?.archiveReview(name, entry.sealedVersion);
    } catch (error) {
      console.error(`[waypoint] could not archive the review for ${name}:`, error);
    }
  }
  panel?.webview.postMessage({
    type: "regenerated",
    name,
    abandoned: outcome.abandoned ?? false,
    changed: outcome.changed ?? !(outcome.abandoned ?? false),
  });
  try {
    await tracker?.regenerationFinished(
      name,
      (await store?.getCurrentVersion(name)) ?? 0,
      mtimeMs,
      outcome,
    );
  } catch (error) {
    console.error(`[waypoint] regeneration_finished failed for ${name}:`, error);
  }
}

/** Open a wait: the agent has been asked to rewrite this plan. */
function beginRegeneration(name: string, reviewPath = "", sealedVersion = 0) {
  clearPending(name);
  pendingReview.set(name, {
    reviewPath,
    sealedVersion,
    abandon: setTimeout(
      () => void finishRegeneration(name, 0, { abandoned: true }),
      ABANDON_MS,
    ),
  });
  panel?.webview.postMessage({ type: "regenerating", name });
}

/**
 * The agent's own "I'm done" (#D10). Read the signal, delete it, end the wait.
 * A signal for a plan nobody is waiting on is ignored — the agent may have run
 * apply from the terminal without a send-back behind it.
 */
async function handleSignal(uri: vscode.Uri) {
  let payload: any;
  try {
    payload = JSON.parse(await readFile(uri.fsPath, "utf8"));
  } catch (error) {
    console.error("[waypoint] unreadable signal:", error);
    return;
  } finally {
    await rm(uri.fsPath, { force: true }).catch(() => {});
  }
  const name = String(payload?.plan ?? "");
  if (!name) return;
  // A finished update that changed the plan means a new version awaits
  // review, so the viewer's Accepted state no longer describes it. This is
  // posted whether or not anyone was waiting: a hand-run /waypoint-update has
  // no Reflect behind it, and is exactly the case that used to leave the
  // header stuck on "Reopen".
  if (payload?.event === "update_finished" && payload?.changed !== false)
    panel?.webview.postMessage({ type: "reopened", name });
  if (!pendingReview.has(name)) return;
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(join(store!.plansDir, name))).mtimeMs;
  } catch {
    // The plan is unreadable; the turnaround still stands on its own.
  }
  await finishRegeneration(name, mtimeMs, {
    signalled: true,
    changed: payload?.changed !== false,
  });
}

/** A write landed on a plan awaiting regeneration: restart its quiet window. */
function noteRegenerationWrite(name: string, mtimeMs: number) {
  const entry = pendingReview.get(name);
  if (!entry) return;
  clearTimeout(entry.settle);
  entry.settle = setTimeout(
    () => void finishRegeneration(name, mtimeMs, { changed: true }),
    SETTLE_MS,
  );
}

let fileEventQueue: Promise<void> = Promise.resolve();
function enqueuePlanFileEvent(uri: vscode.Uri) {
  fileEventQueue = fileEventQueue.then(
    () => handlePlanFileEvent(uri),
    () => handlePlanFileEvent(uri),
  );
}

/**
 * Stat a path that may be mid-rewrite. An agent replacing a plan atomically
 * leaves a window where the name does not exist; without the retry the event
 * was dropped to console.error and the write went unlogged.
 */
async function statSettled(path: string) {
  try {
    return await stat(path);
  } catch {
    await new Promise((r) => setTimeout(r, 150));
    return await stat(path);
  }
}

async function handlePlanFileEvent(uri: vscode.Uri) {
  if (!store || !tracker) return;
  const name = uri.path.split("/").pop()!;
  if (!name.endsWith(".md") || name.endsWith(".review.md")) return;
  try {
    const [version, file] = await Promise.all([
      store.getCurrentVersion(name),
      statSettled(uri.fsPath),
    ]);
    const outcome = await recordPlanFileEvent(
      tracker,
      lastMtime,
      name,
      version,
      file.mtimeMs,
    );
    if (outcome !== "none") noteRegenerationWrite(name, file.mtimeMs);
  } catch (error) {
    console.error(`[waypoint] interaction file event failed for ${name}:`, error);
  }
}

/** One debounce timer per plan: a shared one let writes to two plans coalesce. */
const debounces = new Map<string, ReturnType<typeof setTimeout>>();
function handleChange(uri: vscode.Uri) {
  if (!store) return;
  const name = uri.path.split("/").pop()!;
  if (!name.endsWith(".md") || name.endsWith(".review.md")) return;
  if (!panel) void openPanel(); // auto-open on a new/changed plan
  clearTimeout(debounces.get(name));
  debounces.set(
    name,
    setTimeout(async () => {
      debounces.delete(name);
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(join(store!.plansDir, name))).mtimeMs;
      } catch {
        // removed; the webview refetches the list regardless
      }
      if (!panel || !webviewReady) {
        // Replayed by the "ready" handshake once the bundle has booted.
        pendingChanges.set(name, mtimeMs);
        return;
      }
      panel.webview.postMessage({ type: "changed", name, mtimeMs });
    }, 120),
  );
}

/**
 * Reveal the panel, building it if there is none.
 *
 * Serialized through `opening`: the first `await` below yields, so two watcher
 * events arriving together would both see `!panel` and both create one. The
 * guard is a promise rather than a boolean because the window between the call
 * and the assignment is exactly what has to be covered.
 */
async function openPanel(): Promise<void> {
  if (opening) return opening;
  opening = buildPanel().finally(() => {
    opening = undefined;
  });
  return opening;
}

async function buildPanel(): Promise<void> {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  // Opening the panel is the deliberate opt-in that initializes a workspace
  // (creates .waypoint/ and installs the kit); bare activation never does.
  if (!(await ensureStore(true))) {
    vscode.window.showWarningMessage(
      "Waypoint: open a folder to use the plan viewer.",
    );
    return;
  }
  const mediaUri = vscode.Uri.joinPath(context.extensionUri, "media");
  panel = vscode.window.createWebviewPanel(
    "waypoint",
    "Waypoint",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaUri],
    },
  );
  panel.webview.html = renderHtml(panel.webview, mediaUri);
  tracker?.setVisible(panel.visible);
  panel.onDidChangeViewState((event) => void tracker?.setVisible(event.webviewPanel.visible));
  panel.onDidDispose(() => {
    void tracker?.dispose();
    panel = undefined;
    // The next panel boots a fresh webview, which has seen nothing.
    webviewReady = false;
    pendingChanges.clear();
  });
  panel.webview.onDidReceiveMessage((m) => dispatch(m));
}

/**
 * Where a file reference opens: the group to the *left* of the plan, so the
 * code and the plan that describes it sit side by side. When the plan is the
 * leftmost group there is no left of it — the plan slides one group right and
 * hands over column one, which is the split the reviewer asked for either way.
 */
function columnLeftOfPanel(): vscode.ViewColumn {
  const current = panel?.viewColumn ?? vscode.ViewColumn.Two;
  if (current <= vscode.ViewColumn.One) {
    panel?.reveal(vscode.ViewColumn.Two, true);
    return vscode.ViewColumn.One;
  }
  return current - 1;
}

/**
 * A candidate path → the file it names, or null. Falls back to a basename
 * search for bare names (plans write `planStore.ts`, not the full path), and
 * only accepts it when the repo holds exactly one such file — an ambiguous
 * name is left unlinked rather than opening a coin flip.
 */
async function resolveRefPath(path: string): Promise<string | null> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return null;
  const direct = await resolveDirect(ws.uri.fsPath, path);
  if (direct) return direct;
  if (!isBareName(path)) return null;
  try {
    const hits = await vscode.workspace.findFiles(
      `**/${path}`,
      "**/{node_modules,.git,out,dist,build}/**",
      2,
    );
    return hits.length === 1 ? hits[0].fsPath : null;
  } catch {
    return null;
  }
}

async function dispatch(m: any) {
  if (!store) return;
  const reply = (result: unknown) =>
    panel?.webview.postMessage({ id: m.id, result });
  try {
    switch (m.type) {
      case "listPlans":
        return reply(await store.listPlans());
      case "getPlan":
        return reply(await store.getPlan(m.name));
      case "listVersions":
        return reply(await store.listVersions(m.name));
      case "getVersion":
        return reply(await store.getVersion(m.name, m.version));
      case "setViewedPlan": {
        const file = await stat(join(store.plansDir, m.name));
        await tracker?.selectPlan(m.name, m.version, m.trigger, file.mtimeMs);
        return reply(undefined);
      }
      case "listComments":
        return reply(await store.readComments(m.name));
      case "saveComments":
        await store.writeComments(m.name, m.comments);
        return reply(undefined);
      // Checklist write-through: the plan file is the single source of truth;
      // the watcher's re-render replaces the webview's optimistic DOM.
      // Logged only after the file edit succeeds, as a content-free hash key.
      case "addCriterion": {
        const ok = await store.editChecklist(m.name, m.ord, "add", m.text);
        if (ok)
          await tracker?.trackClientInteraction(m.name, await store.getCurrentVersion(m.name), {
            type: "criterion_added",
            checklistOrd: m.ord,
            criterionKey: criterionKey(m.text),
            isHuman: isHumanCriterion(m.text),
            charCount: m.text.length,
          });
        return reply(ok);
      }
      case "removeCriterion": {
        const ok = await store.editChecklist(m.name, m.ord, "remove", m.text);
        if (ok)
          await tracker?.trackClientInteraction(m.name, await store.getCurrentVersion(m.name), {
            type: "criterion_removed",
            checklistOrd: m.ord,
            criterionKey: criterionKey(m.text),
            isHuman: isHumanCriterion(m.text),
            charCount: m.text.length,
          });
        return reply(ok);
      }
      case "setCriterion": {
        const ok = await store.editChecklist(m.name, m.ord, "set", m.text, !!m.checked);
        if (ok)
          await tracker?.trackClientInteraction(m.name, await store.getCurrentVersion(m.name), {
            type: "criterion_set",
            checklistOrd: m.ord,
            criterionKey: criterionKey(m.text),
            isHuman: isHumanCriterion(m.text),
            checked: !!m.checked,
          });
        return reply(ok);
      }
      // Inline prose editing: a minimal byte splice into the live plan, plus
      // the baseline the viewer redlines this round of edits against.
      case "editPlanText":
        return reply(
          await store.editText(m.name, m.start, m.end, m.expected, m.text),
        );
      case "getBaseline":
        return reply(await store.readBaseline(m.name));
      // File references in plan prose. `resolveRefs` gates the link affordance
      // (only paths that name a real file become clickable); `openRef` opens
      // one beside the plan. Resolution is deduped per request; a plan cites
      // the same file many times.
      case "resolveRefs": {
        const paths: string[] = Array.isArray(m.paths) ? m.paths.slice(0, 400) : [];
        const resolved: Record<string, boolean> = {};
        await Promise.all(
          [...new Set(paths)].map(async (p) => {
            resolved[p] = (await resolveRefPath(p)) != null;
          }),
        );
        return reply(resolved);
      }
      case "openRef": {
        const target = await resolveRefPath(String(m.path ?? ""));
        if (!target) {
          vscode.window.showWarningMessage(
            `Waypoint: no file named ${m.path} in this workspace.`,
          );
          return reply(false);
        }
        const doc = await vscode.workspace.openTextDocument(target);
        const line = Number.isInteger(m.line) && m.line > 0 ? m.line - 1 : undefined;
        const at =
          line == null
            ? undefined
            : new vscode.Range(
                Math.min(line, doc.lineCount - 1),
                0,
                Math.min(line, doc.lineCount - 1),
                0,
              );
        const editor = await vscode.window.showTextDocument(doc, {
          viewColumn: columnLeftOfPanel(),
          preview: true,
          selection: at,
        });
        if (at) editor.revealRange(at, vscode.TextEditorRevealType.InCenter);
        await tracker?.trackClientInteraction(
          m.name,
          await store.getCurrentVersion(m.name),
          {
            type: "ref_opened",
            refKey: refKey(String(m.path)),
            hasLine: line != null,
          },
        );
        return reply(true);
      }
      case "trackInteraction": {
        // The webview passes the viewed version so events fired while reading
        // sealed history carry that version, not the current one.
        const version = Number.isInteger(m.version)
          ? (m.version as number)
          : await store.getCurrentVersion(m.name);
        await tracker?.trackClientInteraction(m.name, version, m.interaction);
        return reply(undefined);
      }
      // The webview has booted and installed its listeners. Anything the
      // watcher saw before this point was posted into the void; replay it.
      case "ready": {
        webviewReady = true;
        for (const [name, mtimeMs] of pendingChanges)
          panel?.webview.postMessage({ type: "changed", name, mtimeMs });
        pendingChanges.clear();
        return reply(undefined);
      }
      case "setFocus":
        await tracker?.setFocus(!!m.focused);
        return reply(undefined);
      case "sendReview": {
        // Write the handoff prompt, then seal the current version (snapshotting
        // its text + comments as resolved) before clearing active comments.
        const comments = await store.readComments(m.name);
        const { prompt, path, edits } = await store.writeReview(m.name);
        const sealedVersion = await store.sealCurrent(
          m.name,
          sendBackNote(comments.length, edits.length),
        );
        await vscode.env.clipboard.writeText(prompt);
        const send = await sendApply();
        const { injected, command, agent } = send;
        await tracker?.reviewSent(m.name, sealedVersion, comments, send, {
          editCount: edits.filter((e) => e.kind === "prose").length,
          gateChangeCount: edits.filter((e) => e.kind === "criterion").length,
        });
        // The viewer's version label has already moved to the next version, but
        // the prose on screen is still the old one until the agent writes. Spin
        // from here, on the host's authority, until that write settles.
        beginRegeneration(m.name, path, sealedVersion);
        return reply({ path, injected, sealedVersion, command, agent });
      }
      case "implementPlan": {
        const version = await store.getCurrentVersion(m.name);
        const upToPhase =
          Number.isInteger(m.upToPhase) && m.upToPhase > 0
            ? (m.upToPhase as number)
            : undefined;
        const send = await sendImplement(m.name, upToPhase);
        // Accepting closes the review round: the reviewer's edits are now just
        // the plan, so the redline they were shown against clears.
        await store.clearBaseline(m.name);
        await tracker?.planAccepted(m.name, version, version - 1, send, upToPhase);
        return reply({
          injected: send.injected,
          command: send.command,
          agent: send.agent,
        });
      }
      // Repo setup: the skills the agents need before /waypoint works here.
      case "kitStatus": {
        const ws = vscode.workspace.workspaceFolders?.[0];
        return reply(
          ws
            ? await kitStatus(kitRoot(), ws.uri.fsPath)
            : { missing: [], total: 0 },
        );
      }
      // Both are explicit user actions, so they also clear the pre-rename
      // `galley*` skill dirs; the silent refresh in ensureStore never does.
      case "installKit":
      case "reinstallKit": {
        const ws = vscode.workspace.workspaceFolders?.[0];
        return reply(
          ws
            ? await installKit(kitRoot(), ws.uri.fsPath, true, { removeLegacy: true })
            : undefined,
        );
      }
      case "reflectPlan": {
        // Seal before the update rewrites the plan, so the viewer's redline
        // diff baselines against the pre-update text rather than the last
        // review send (which would mix implementation tick-marks in).
        // The note is the trigger only; the update skill's seal.py overwrites
        // it with the substantive reason once the agent has read the delta.
        const sealedVersion = await store.sealCurrent(
          m.name,
          "Reflect requested in the Waypoint viewer.",
        );
        const send = await sendUpdate(m.name);
        await tracker?.trackClientInteraction(m.name, sealedVersion, {
          type: "reflect_requested",
          terminalInjected: send.injected,
          ...(send.agent ? { agent: send.agent } : {}),
          ...(send.command ? { command: send.command } : {}),
        });
        // Reflect seals and rewrites exactly as a send-back does, so it gets the
        // same spinner: without it the version label moves while the old prose
        // stays on screen, which is the silent swap Phase 4 exists to end.
        beginRegeneration(m.name);
        return reply({
          injected: send.injected,
          command: send.command,
          agent: send.agent,
        });
      }
    }
  } catch (err) {
    console.error("[waypoint] dispatch failed:", m?.type, err);
    reply(undefined);
  }
}

/** The version note for a Send back: what the round carried, in one line. */
function sendBackNote(comments: number, edits: number): string {
  const parts: string[] = [];
  if (comments) parts.push(`${comments} comment${comments === 1 ? "" : "s"}`);
  if (edits) parts.push(`${edits} direct edit${edits === 1 ? "" : "s"}`);
  return parts.length
    ? `Sent back for revision with ${parts.join(" and ")}.`
    : "Sent back for revision.";
}

function nonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function renderHtml(webview: vscode.Webview, mediaUri: vscode.Uri): string {
  const jsPath = vscode.Uri.joinPath(mediaUri, "webview.js");
  const cssPath = vscode.Uri.joinPath(mediaUri, "webview.css");
  // Cache-bust by the bundle's mtime. VS Code's webview resource loader caches
  // by URI, so without a version query a rebuilt webview.js is served stale
  // (survives window reload / F5) until the cache is cleared.
  const ver = (p: vscode.Uri) => {
    try {
      return String(Math.round(statSync(p.fsPath).mtimeMs));
    } catch {
      return "0";
    }
  };
  const js = webview
    .asWebviewUri(jsPath)
    .with({ query: `v=${ver(jsPath)}` });
  const css = webview
    .asWebviewUri(cssPath)
    .with({ query: `v=${ver(cssPath)}` });
  const n = nonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${n}'`,
  ].join("; ");
  const base = webview.asWebviewUri(mediaUri);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <base href="${base}/" />
    <link rel="stylesheet" href="${css}" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" nonce="${n}" src="${js}"></script>
  </body>
</html>`;
}

export function deactivate() {
  // Close any open reading interval synchronously — the async queue would not
  // survive host shutdown, and an unclosed interval loses the whole view.
  tracker?.flushSync();
}
