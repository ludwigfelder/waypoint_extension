import { request } from "./bridge";
import type { Comment, VersionInfo } from "../../shared/review";
import type { ClientInteraction, ViewStartTrigger } from "../../shared/interactionLog";

export type Plan = { name: string; mtimeMs: number };
export type { VersionInfo };

export function listPlans(): Promise<Plan[]> {
  return request<Plan[]>("listPlans");
}

export function getPlan(name: string): Promise<string> {
  return request<string>("getPlan", { name });
}

export function listVersions(name: string): Promise<VersionInfo[]> {
  return request<VersionInfo[]>("listVersions", { name });
}

export type VersionDoc = {
  version: number;
  current: boolean;
  markdown: string;
  comments: Comment[];
  /** Why this sealed version was superseded; only on resolved versions. */
  note?: string;
};

export function getVersion(name: string, version: number): Promise<VersionDoc> {
  return request<VersionDoc>("getVersion", { name, version });
}

export function setViewedPlan(
  name: string,
  version: number,
  trigger: ViewStartTrigger,
): Promise<void> {
  return request<void>("setViewedPlan", { name, version, trigger });
}

export function trackInteraction(
  name: string,
  interaction: ClientInteraction,
  version?: number,
): Promise<void> {
  // `version` is the version being viewed, so events fired while reading
  // sealed history are attributed to it; the host falls back to current.
  return request<void>("trackInteraction", { name, interaction, version });
}

/**
 * Webview focus refines the host's reading intervals: focused means the
 * window has focus and the document is visible. The host stays authoritative
 * for interval boundaries (panel visibility).
 */
export function setFocus(focused: boolean): Promise<void> {
  return request<void>("setFocus", { focused });
}

/**
 * Checklist write-through: persist a criterion edit into the plan file itself.
 * `ord` addresses the checklist by its 0-based document-order index; `text` is
 * the criterion's raw source text (including any `@human ` marker). The
 * extension edits the file and the watcher re-renders the viewer.
 */
export function addCriterion(name: string, ord: number, text: string): Promise<boolean> {
  return request<boolean>("addCriterion", { name, ord, text });
}

export function removeCriterion(name: string, ord: number, text: string): Promise<boolean> {
  return request<boolean>("removeCriterion", { name, ord, text });
}

export function setCriterion(
  name: string,
  ord: number,
  text: string,
  checked: boolean,
): Promise<boolean> {
  return request<boolean>("setCriterion", { name, ord, text, checked });
}

/**
 * Inline prose write-through: replace `[start, end)` of the plan file with
 * `text`. `expected` is the source the viewer believes is there — the host
 * refuses the edit if the file moved underneath, and `ok: false` comes back
 * with the file's actual contents so the viewer can re-sync.
 */
export function editPlanText(
  name: string,
  start: number,
  end: number,
  expected: string,
  text: string,
): Promise<{ ok: boolean; markdown: string }> {
  return request<{ ok: boolean; markdown: string }>("editPlanText", {
    name,
    start,
    end,
    expected,
    text,
  });
}

/**
 * The plan as it stood when this round of inline edits began ("" when there
 * have been none). The viewer redlines the live document against it.
 */
export function getBaseline(name: string): Promise<string> {
  return request<string>("getBaseline", { name });
}

/** What a terminal send did: whether it landed, and the exact text typed. */
export type SendResult = {
  injected: boolean;
  command?: string;
  agent?: string;
};

/**
 * Accept the plan and hand it to the agent: types the implement trigger into the
 * agent's terminal, capped at `upToPhase` for a partial accept. `injected` is
 * true if a terminal received the text, and `command` is that text — the form
 * differs per CLI, so the toast quotes this rather than assuming a slash command.
 */
export function implementPlan(
  name: string,
  upToPhase?: number,
): Promise<SendResult> {
  return request<SendResult>("implementPlan", { name, upToPhase });
}

/**
 * After a partial implement finishes, ask the agent to reconcile the plan's
 * remaining phases: types the update trigger into the agent's terminal.
 */
export function reflectPlan(name: string): Promise<SendResult> {
  return request<SendResult>("reflectPlan", { name });
}

/**
 * File references in plan prose. `resolveRefs` asks which candidate paths name
 * a real file in the workspace — only those get the link affordance, so the
 * viewer never offers a link that leads nowhere. `openRef` opens one in the
 * editor group left of the plan, at `line` when the reference carried one.
 */
export function resolveRefs(paths: string[]): Promise<Record<string, boolean>> {
  return request<Record<string, boolean>>("resolveRefs", { paths });
}

export function openRef(
  name: string,
  path: string,
  line?: number,
): Promise<boolean> {
  return request<boolean>("openRef", { name, path, line });
}

export type KitStatus = { missing: string[]; total: number };
export type KitInstallResult = {
  installed: string[];
  skipped: string[];
  gitignore: "created" | "updated" | "unchanged";
};

/**
 * Repo setup: the agents need the Waypoint skills (and slash commands) inside
 * the workspace before /waypoint works there. `kitStatus` lists the kit files
 * this workspace is missing; `installKit` copies them in from the extension
 * bundle (never overwriting existing files) and adds the ignore block to
 * .gitignore. `reinstallKit` is the header-menu "Reinstall Waypoint" action:
 * same copy, but overwriting, so stale kits pick up the bundled versions.
 */
export function kitStatus(): Promise<KitStatus> {
  return request<KitStatus>("kitStatus");
}

export function installKit(): Promise<KitInstallResult> {
  return request<KitInstallResult>("installKit");
}

export function reinstallKit(): Promise<KitInstallResult> {
  return request<KitInstallResult>("reinstallKit");
}
