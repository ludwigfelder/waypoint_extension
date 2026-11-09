// Which CLI is running in a terminal, read from the OS process tree. Kept
// vscode-free so tests can exercise the parsing directly (terminal.ts owns the
// `waypoint.agent` setting, the name fallback, and the sending).
import { execFile } from "node:child_process";
import type { Agent } from "./agentCommand";

/**
 * Match on the *full command line*, not the process name: Claude Code runs as
 * `node …/claude`, so a `comm=`-based match would find Codex and never Claude
 * (#D3). Word-bounded so a path like `/Users/x/codex-notes` cannot pose as the
 * CLI.
 */
const AGENT_PATTERNS: Array<{ agent: Agent; re: RegExp }> = [
  { agent: "codex", re: /(?:^|\/|\s)codex(?:\s|$)/ },
  { agent: "claude", re: /(?:^|\/|\s)claude(?:\s|$)/ },
];

/**
 * Which agent is running somewhere under `rootPid`, read from `ps` output
 * (`pid ppid command` per line). Walking the whole subtree is what survives a
 * wrapper: a session recorder may run the CLI under `script -q`, so the
 * terminal's direct child is `script` and the CLI sits one level deeper.
 *
 * Ambiguity is reported honestly as `"unknown"`, which selects the command form
 * both CLIs accept (#D1) — better than guessing wrong, which is the bug this
 * fixes.
 */
export function agentFromPsOutput(psText: string, rootPid: number): Agent {
  const children = new Map<number, Array<{ pid: number; command: string }>>();
  const own = new Map<number, string>();
  for (const line of psText.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    own.set(pid, m[3]);
    const siblings = children.get(ppid) ?? [];
    siblings.push({ pid, command: m[3] });
    children.set(ppid, siblings);
  }

  // Breadth-first over the subtree, collecting every descendant's command line.
  const commands: string[] = [];
  const rootCommand = own.get(rootPid);
  if (rootCommand != null) commands.push(rootCommand);
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue; // a cycle would be pathological, but cheap to rule out
      seen.add(child.pid);
      commands.push(child.command);
      queue.push(child.pid);
    }
  }

  const matched = AGENT_PATTERNS.filter(({ re }) =>
    commands.some((command) => re.test(command)),
  );
  return matched.length === 1 ? matched[0].agent : "unknown";
}

function ps(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-Ao", "pid=,ppid=,command="],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? "" : stdout),
    );
  });
}

/**
 * Which agent is running under `rootPid`, or `"unknown"` if the probe cannot
 * tell. Unix only — there is no `ps` on Windows, where the caller falls back to
 * the terminal name (#D4).
 */
export async function agentFromProcessTree(rootPid: number): Promise<Agent> {
  if (process.platform === "win32") return "unknown";
  try {
    return agentFromPsOutput(await ps(), rootPid);
  } catch {
    return "unknown";
  }
}
