import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFromPsOutput } from "../src/extension/agentDetect";
import { InteractionLogger } from "../src/extension/interactionLogger";
import { InteractionTracker } from "../src/extension/interactionTracker";
import {
  assertInteractionEvent,
  INTERACTION_LOG_SCHEMA_VERSION,
} from "../src/shared/interactionLog";

// `ps -Ao pid=,ppid=,command=` output: pid, ppid, then the full command line.
// The terminal's shell is pid 500 in every fixture, which is what
// `terminal.processId` hands us.
const SHELL = "  500     1 /bin/zsh -l";
const NOISE = [
  "    1     0 /sbin/launchd",
  "  400     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  "  999     1 /usr/sbin/cupsd -l",
].join("\n");

const tree = (...lines: string[]) => [NOISE, SHELL, ...lines].join("\n");

describe("agentFromPsOutput", () => {
  test("a codex child of the shell is found", () => {
    const ps = tree("  501   500 /opt/homebrew/Caskroom/codex/0.146.0/bin/codex");
    expect(agentFromPsOutput(ps, 500)).toBe("codex");
  });

  test("codex nested under `script -q` is found", () => {
    // What a session recorder wrapping the CLI in `script -q` produces: the
    // shell's direct child is `script`, and codex sits one level deeper.
    const ps = tree(
      "  501   500 script -q /tmp/session/cli.log codex",
      "  502   501 /opt/homebrew/Caskroom/codex/0.146.0/bin/codex",
    );
    expect(agentFromPsOutput(ps, 500)).toBe("codex");
  });

  test("claude running as a node process is found (#D3)", () => {
    const ps = tree(
      "  501   500 node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js claude",
    );
    expect(agentFromPsOutput(ps, 500)).toBe("claude");
  });

  test("both CLIs in one tree is ambiguous, not a guess", () => {
    const ps = tree(
      "  501   500 /opt/homebrew/bin/codex",
      "  502   500 node /opt/homebrew/bin/claude",
    );
    expect(agentFromPsOutput(ps, 500)).toBe("unknown");
  });

  test("neither CLI present returns unknown, never claude (#C7)", () => {
    const ps = tree("  501   500 vim notes.md", "  502   500 git status");
    expect(agentFromPsOutput(ps, 500)).toBe("unknown");
  });

  test("a sibling terminal's codex does not leak into this tree", () => {
    // pid 600 is another terminal's shell; only 500's subtree counts.
    const ps = tree("  600     1 /bin/zsh -l", "  601   600 /opt/homebrew/bin/codex");
    expect(agentFromPsOutput(ps, 500)).toBe("unknown");
  });

  test("a path that merely contains the word does not pose as the CLI", () => {
    const ps = tree("  501   500 vim /Users/x/codex-notes/todo.md");
    expect(agentFromPsOutput(ps, 500)).toBe("unknown");
  });

  test("unparseable or empty ps output is unknown, not a crash", () => {
    expect(agentFromPsOutput("", 500)).toBe("unknown");
    expect(agentFromPsOutput("garbage\n\n", 500)).toBe("unknown");
  });
});

describe("the log records which CLI received the trigger", () => {
  const dirs: string[] = [];
  afterEach(() =>
    Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))),
  );

  const tracker = async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-agent-"));
    dirs.push(dir);
    let id = 0;
    const now = 1_000;
    const logger = new InteractionLogger(dir, () => now, undefined, () => `e${++id}`);
    const t = new InteractionTracker(logger, () => now, () => `s${++id}`);
    await t.init();
    await t.planCreated("plan.md", 1, 900);
    return t;
  };

  test("agent and command reach review_sent and plan_accepted", async () => {
    const t = await tracker();
    await t.reviewSent("plan.md", 1, [], {
      injected: true,
      agent: "codex",
      command: "$waypoint-apply",
    });
    await t.planAccepted("plan.md", 1, 0, {
      injected: true,
      agent: "claude",
      command: "/waypoint-implement plan.md",
    });
    const events = t.snapshot() as any[];
    const sent = events.find((e) => e.type === "review_sent");
    expect(sent.agent).toBe("codex");
    expect(sent.command).toBe("$waypoint-apply");
    expect(sent.terminalInjected).toBe(true);
    const accepted = events.find((e) => e.type === "plan_accepted");
    expect(accepted.agent).toBe("claude");
    expect(accepted.command).toBe("/waypoint-implement plan.md");
  });

  // #D5: the fields are optional, so records written before this change — and
  // the boolean call shape — stay valid without a schema bump.
  test("a review_sent without agent/command still validates", async () => {
    const t = await tracker();
    await t.reviewSent("plan.md", 1, [], true);
    const sent = (t.snapshot() as any[]).find((e) => e.type === "review_sent");
    expect("agent" in sent).toBe(false);
    expect("command" in sent).toBe(false);
    expect(sent.terminalInjected).toBe(true);
    expect(() =>
      assertInteractionEvent({
        schemaVersion: INTERACTION_LOG_SCHEMA_VERSION,
        eventId: "e1",
        timestamp: new Date(0).toISOString(),
        plan: "plan.md",
        version: 1,
        type: "review_sent",
        iteration: 1,
        commentCount: 0,
        creationToActionMs: 0,
        latestUpdateToActionMs: 0,
        activeReadingMs: 0,
        terminalInjected: true,
      }),
    ).not.toThrow();
    expect(INTERACTION_LOG_SCHEMA_VERSION).toBe(1);
  });
});
