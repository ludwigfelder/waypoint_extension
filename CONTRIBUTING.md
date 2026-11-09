# Contributing to Waypoint

## Build and test

```sh
bun install
bun run build     # out/extension.js, media/webview.{js,css}, resources/kit/
bun test
```

`bun run watch` rebuilds on source changes.

## Run it

Two options:

- **Installed VSIX (what we use).** `./reload.sh` builds, packages to
  `waypoint.vsix` and force-installs it into your normal VS Code. Then reload the
  window (**Developer: Reload Window**). No version bump is needed for ordinary
  work; bump `version` in `package.json` only when VS Code must treat the build
  as a distinct release (it caches contributed icons by install path, for
  example).
- **Extension Development Host.** Press F5 (*Run Waypoint Extension*) to launch a
  separate window with the extension loaded from `out/`.

`bun run package` produces `waypoint-<version>.vsix`; `bun run publish` publishes
it with the stored `vsce` login.

## How it works

- **Extension host** (`src/extension/`). `extension.ts` registers the
  commands, resolves the workspace data dir (`waypointDir.ts`: `.waypoint/`, with
  fallbacks for the pre-rename `.galley/` and `.claude/waypoint/`), watches
  `plans/` with a `FileSystemWatcher`, hosts the webview and dispatches its
  messages. `planStore.ts` lists and reads plans, comments and sealed
  versions and writes reviews. `terminal.ts` and `agentCommand.ts` type the
  skill invocation into the right terminal in the right CLI's syntax;
  `agentDetect.ts` reads the terminal's process tree to tell Claude Code from
  Codex. `skillsKit.ts` installs the bundled agent kit into a workspace.
  `interactionLogger.ts` and `interactionTracker.ts` write the local
  interaction log.
- **Webview** (`src/webview/`). A Svelte 5 app styled with Tailwind v4.
  `App.svelte` orchestrates `Header` (plan and version pickers, status,
  actions), `PlanDocument` (rendered markdown, highlights, margin comment
  cards, selection toolbar, outline), `DiffDocument` (redline between
  versions) and `PhaseProgress`. Markdown is rendered by `lib/markdown.ts`
  (`marked` + `highlight.js`, sanitized with DOMPurify) with the plan-format
  extensions (callouts, checklists, collapses, mermaid). Comment highlights use
  the CSS Custom Highlight API. The host bridge is `lib/bridge.ts`.
- **Shared** (`src/shared/`). The review-prompt formatter and the interaction
  log schema, used by both sides.
- **Agent kit** (`.agents/skills/waypoint*`). The four skills and their helper
  scripts (`tick.py`, `signal.py`, `seal.py`). `.claude/skills` is a symlink to
  the same dir. `build.ts` copies them into `resources/kit/`, which ships in
  the VSIX and is what the extension installs into user repos.

## Data layout in a workspace

```
.waypoint/
  plans/<slug>.md              the live plan
  plans/.comments/<slug>.md    active comments
  plans/<slug>.review.md       a review waiting for /waypoint-apply
  versions/<slug>/v<N>.md      sealed versions, with v<N>.comments.md,
                               v<N>.review.md and v<N>.note.md
  signals/<slug>.json          "the agent finished" signals from the scripts
  logs/interactions.jsonl      the local interaction log
```

## Releasing

Bump `version` in `package.json`, add a `CHANGELOG.md` entry, commit, tag
`v<version>` and push the tag. The release workflow packages and publishes.
Publishing by hand: `bun run publish` (needs `vsce login LudwigFelder` once).
