import * as vscode from "vscode";
import { formatCommand, type Agent } from "./agentCommand";
import { agentFromProcessTree } from "./agentDetect";

/** What a send did: the text typed, and which CLI we believed was listening. */
export type SendResult = {
  injected: boolean;
  agent: Agent;
  command: string;
};

/** Choose the terminal to send the Waypoint trigger to. */
function pickTerminal(): vscode.Terminal | undefined {
  const configured = vscode.workspace
    .getConfiguration("waypoint")
    .get<string>("terminalName");
  const terminals = vscode.window.terminals;
  if (configured) return terminals.find((t) => t.name.includes(configured));
  return (
    terminals.find((t) => /claude|codex/i.test(t.name)) ??
    vscode.window.activeTerminal ??
    terminals[0]
  );
}

/**
 * Which CLI is listening: the `waypoint.agent` setting if it names one, else the
 * terminal's process tree, else its name, else `"unknown"`. The name is the last
 * signal rather than the only one because it is a *display* string — VS Code
 * derives it from the tab title, which a customized title or a wrapper process
 * leaves saying nothing about the CLI (#A5).
 */
async function detectAgent(terminal: vscode.Terminal): Promise<Agent> {
  const configured = vscode.workspace
    .getConfiguration("waypoint")
    .get<string>("agent");
  if (configured === "claude" || configured === "codex") return configured;

  try {
    const pid = await terminal.processId;
    if (pid != null) {
      const fromProcess = await agentFromProcessTree(pid);
      if (fromProcess !== "unknown") return fromProcess;
    }
  } catch {
    // Fall through to the name test.
  }

  return /codex/i.test(terminal.name) ? "codex" : "unknown";
}

/**
 * How long to wait between typing the trigger and pressing Enter.
 *
 * `sendText(text, true)` writes the text and the carriage return in one burst
 * (VS Code appends `\r` itself — it is not sending a bare newline). Codex's
 * composer classifies a fast burst as *pasted* input, so that trailing return
 * lands as a line break inside the composer instead of submitting: the trigger
 * appears, correctly, and nothing runs. Pressing Enter as a separate keystroke
 * once the burst window has closed submits it.
 *
 * The window is not documented and the binary carries no timing constant, so
 * this is deliberately generous — a quarter second is imperceptible to the
 * reviewer who just clicked, and being late costs nothing while being early
 * costs the whole round.
 */
const SUBMIT_DELAY_MS = 250;

/**
 * Codex opens a skill-completion popup as soon as a `$name` token is typed, and
 * that popup owns the next return: it says so itself — "Press enter to insert or
 * esc to close". So the first return inserts the completion (rewriting the token
 * as a markdown link to the skill) and the message stays in the composer. A
 * second return submits it.
 *
 * Only the `$` form can open that popup, so only it gets the extra return. The
 * second return is harmless when the first one already submitted: it lands on an
 * empty composer and Codex ignores it (verified — one API call, one reply).
 */
const POPUP_DELAY_MS = 150;

/** Type the trigger, then press Enter as its own keystroke. */
async function typeAndSubmit(
  terminal: vscode.Terminal,
  command: string,
): Promise<void> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  terminal.sendText(command, false); // text only, no return yet
  await sleep(SUBMIT_DELAY_MS);
  terminal.sendText("\r", false); // inserts the skill completion, or submits
  if (command.startsWith("$")) {
    await sleep(POPUP_DELAY_MS);
    terminal.sendText("\r", false); // submits when the popup ate the first one
  }
}

/** Type a Waypoint trigger into the chosen terminal. */
async function send(
  name: string,
  args?: string,
  upToPhase?: number,
): Promise<SendResult> {
  const terminal = pickTerminal();
  if (!terminal) return { injected: false, agent: "unknown", command: "" };
  const agent = await detectAgent(terminal);
  const command = formatCommand(agent, name, args, upToPhase);
  terminal.show(true); // reveal, preserve focus
  await typeAndSubmit(terminal, command);
  // `sendText` reports nothing about whether the CLI accepted the text, so
  // `injected` means "typed", not "understood" (#A7) — hence `command`, which
  // lets the toast and the log say what was actually sent.
  return { injected: true, agent, command };
}

/** Type the apply trigger into the chosen terminal. */
export function sendApply(): Promise<SendResult> {
  return send("waypoint-apply");
}

/**
 * Type the implement trigger into the chosen terminal so the agent knows which
 * plan to implement; `upToPhase` caps the run at that phase.
 */
export function sendImplement(
  name?: string,
  upToPhase?: number,
): Promise<SendResult> {
  return send("waypoint-implement", name, upToPhase);
}

/**
 * Type the update trigger into the chosen terminal — reconcile a plan's
 * remaining phases after a partial implement.
 */
export function sendUpdate(name?: string): Promise<SendResult> {
  return send("waypoint-update", name);
}
