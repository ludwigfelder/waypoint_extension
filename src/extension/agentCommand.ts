// Pure formatting of Waypoint agent invocations — kept vscode-free so tests
// can exercise it directly. terminal.ts owns terminal picking and sending.

/**
 * Which CLI is listening in the terminal. `unknown` is not a failure: it is the
 * honest answer when neither the `waypoint.agent` setting nor the process tree
 * settles it, and it selects the one command form both CLIs understand (#D1).
 */
export type Agent = "claude" | "codex" | "unknown";

/**
 * Codex invokes a skill explicitly as `$skill-name` — an explicit invocation
 * that works even when skill descriptions are trimmed from the model's context,
 * unlike a phrase that asks the model to pick the skill itself (#D2). The
 * trailing prose carries the arguments, because a plan filename may contain
 * spaces and a bare `--up-to-phase` flag means nothing to a model.
 */
const CODEX_SKILL_ARGS: Record<
  string,
  (args?: string, upToPhase?: number) => string
> = {
  "waypoint-apply": () => "",
  "waypoint-update": (args) =>
    `the Waypoint plan${
      args ? ` ${args}` : ""
    } — reconcile its remaining phases with what the partial implementation revealed.`,
  "waypoint-implement": (args, upToPhase) => {
    const plan = `the accepted Waypoint plan${args ? ` ${args}` : ""}`;
    if (upToPhase != null) {
      return (
        `${plan} — only phases 1 through ${upToPhase}, phase by phase, ticking ` +
        `acceptance criteria as they pass; stop after phase ${upToPhase}.`
      );
    }
    return `${plan} — phase by phase, ticking acceptance criteria as they pass.`;
  },
};

/**
 * The fallback form for an undetermined agent: name the skill in a typed
 * instruction. Both CLIs act on this — Claude invokes the skill from plain
 * language, and Codex reads it as an ordinary prompt against the skills it
 * discovered from the repo's `.agents/skills/`. The phrase mirrors each skill's
 * own description so the model reliably selects it (and still reads as a
 * sensible instruction even if the skill isn't present).
 */
const CODEX_PHRASES: Record<
  string,
  (args?: string, upToPhase?: number) => string
> = {
  "waypoint-apply": () =>
    "Use the waypoint-apply skill to apply the pending Waypoint review comments to their plan files.",
  "waypoint-update": (args) =>
    `Use the waypoint-update skill to reconcile the remaining phases of the Waypoint plan${
      args ? ` ${args}` : ""
    } with what the partial implementation revealed.`,
  "waypoint-implement": (args, upToPhase) => {
    const plan = `the accepted Waypoint plan${args ? ` ${args}` : ""}`;
    if (upToPhase != null) {
      return (
        `Use the waypoint-implement skill to implement ${plan}, but only phases ` +
        `1 through ${upToPhase} — phase by phase, ticking acceptance criteria as ` +
        `they pass — and stop after phase ${upToPhase}.`
      );
    }
    return `Use the waypoint-implement skill to implement ${plan} phase by phase, ticking acceptance criteria as they pass.`;
  },
};

/**
 * Format a Waypoint invocation for the given agent. Claude uses its `/<name>`
 * slash command (a thin wrapper that invokes the same skill), with a phase cap
 * as an explicit `--up-to-phase N` flag (plan filenames may contain spaces, so a
 * trailing natural-language suffix would be ambiguous). Codex uses `$<name>`.
 * An undetermined agent gets the instruction phrase, which neither CLI rejects.
 */
export function formatCommand(
  agent: Agent,
  name: string,
  args?: string,
  upToPhase?: number,
): string {
  if (agent === "codex") {
    const trailing = CODEX_SKILL_ARGS[name]?.(args, upToPhase) ?? args ?? "";
    return trailing ? `$${name} ${trailing}` : `$${name}`;
  }
  if (agent === "unknown") {
    const phrase = CODEX_PHRASES[name];
    if (phrase) return phrase(args, upToPhase);
    return args ? `${name} ${args}` : name;
  }
  const flag = upToPhase != null ? ` --up-to-phase ${upToPhase}` : "";
  return args ? `/${name} ${args}${flag}` : `/${name}${flag}`;
}
