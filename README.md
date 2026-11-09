# Waypoint

Waypoint is a live, reviewable plan viewer for coding agents. Your agent
(Claude Code or Codex) writes a plan into the repo; Waypoint renders it in a VS
Code tab as it is written, lets you highlight passages and leave comments, and
sends your review back to the agent with one click. When the plan is right,
you accept it and the agent implements it phase by phase, ticking acceptance
criteria as they pass.

## Requirements

- VS Code 1.90 or later.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or the OpenAI
  Codex CLI running in VS Code's integrated terminal.
- `python3` on your PATH. The agent skills ship three small helper scripts.

## Install

Search for **Waypoint Plan Reviewer** in the Extensions view, or run:

```sh
code --install-extension LudwigFelder.waypoint-plan-reviewer
```

To install a downloaded `.vsix` instead, use **Extensions: Install from
VSIX…** from the command palette.

## Quick start

1. Open a repo and run **Waypoint: Open Plan Viewer** from the command palette.
   This creates `.waypoint/` and installs the agent skills into the repo (see
   below).
2. In a terminal running Claude Code, type `/waypoint <describe the task>`. With
   Codex, type `$waypoint <describe the task>`. The agent researches the repo
   and writes a plan; the Waypoint tab opens and follows it live.
3. Read the plan. Select any passage to leave a comment in the margin.
4. Click **Send back**. Waypoint compiles your comments into a review and types
   `/waypoint-apply` into the agent's terminal; the agent revises the plan in
   place and the viewer shows a redline of what changed.
5. When the plan is right, click **Accept**. Waypoint types `/waypoint-implement`
   into the terminal, and the agent works through the plan phase by phase,
   ticking each acceptance criterion in the viewer as it passes.

## Features

- **Live rendering.** The viewer watches `.waypoint/plans/` and re-renders on
  every write, so you can read along while the agent plans.
- **Margin comments.** Highlight a passage, write a note. Comments persist
  across reloads and are cleared once the agent applies them.
- **Redline diffs.** Every revision is a version; toggle a redline to see what
  the agent changed in reply to your comments.
- **Assumptions, decisions and gates as first-class blocks.** Plans mark what
  they rely on, what they chose and why, and what proves each phase done.
- **Phase progress.** Accept a whole plan or only up to a phase. The header
  tracks which criteria the agent has ticked and which are waiting on you.
- **Mermaid diagrams, code blocks with filenames, collapsible detail** in the
  plan format the skills teach the agent.
- **Agent-agnostic.** Waypoint detects whether the terminal runs Claude Code or
  Codex and types the matching command form.

## Commands

| Command | What it does |
|---|---|
| **Waypoint: Open Plan Viewer** | Opens the viewer, initializing the workspace on first use |
| **Waypoint: Install Agent Skills into This Repo** | Installs or refreshes the agent skills in the open repo |

The viewer also has an editor-title button that opens it.

## Settings

- `waypoint.terminalName`: substring of the integrated-terminal name Waypoint
  types its commands into. Empty (the default) picks a terminal named like
  `claude` or `codex`, else the active terminal.
- `waypoint.agent`: which CLI that terminal runs, `auto` (default), `claude` or
  `codex`. `auto` inspects the terminal's process tree, then its name. Set it
  explicitly when the CLI runs under a wrapper that hides it.

## What Waypoint writes to your repo

Nothing happens on activation alone. The first time you open the viewer in a
workspace, Waypoint creates:

- `.waypoint/` — plans, comments, sealed versions and a local interaction log.
- `.agents/skills/waypoint*/` and `.claude/skills/waypoint*/` — the four agent
  skills (`waypoint`, `waypoint-apply`, `waypoint-implement`, `waypoint-update`) and
  their helper scripts, one copy per CLI.
- A block in `.gitignore` covering all of the above.

Reopening the viewer refreshes the skills to the bundled version. The install
commands also remove skill dirs left by Galley (`LudwigFelder.galley`), the
earlier Marketplace name of this extension. A repo that already has a
`.galley/` dir from Galley keeps working without changes.

## Privacy

Waypoint records plan-review interaction metadata as newline-delimited JSON in
`.waypoint/logs/interactions.jsonl`. The file stays in the workspace, is
gitignored, and is never transmitted; the extension makes no network requests.
Records hold plan slugs, version numbers, event and session ids, timestamps,
durations and comment counts. They never contain plan text, highlighted
quotes, comment bodies, terminal contents, usernames or machine identifiers.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing and the
architecture of the extension.

## License

MIT. The icon is the "wallpaper" glyph from
[Tabler Icons](https://tabler.io/icons), also MIT.
