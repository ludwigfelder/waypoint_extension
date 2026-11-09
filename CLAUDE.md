# Waypoint — developer notes

VS Code extension (Bun-built). Extension host code in `src/extension/`, the
Svelte webview in `src/webview/`. `bun run build` bundles to `out/extension.js`
and `media/webview.*`.

## Dev workflow: installed VSIX (chosen)

We run Waypoint as an **installed extension in the normal VS Code window**, not
via the F5 Extension Development Host. So after any change to `src/`, rebuild,
repackage, and reinstall — then reload the window.

**Claude Code: after implementing any feature or fix that touches `src/`, run
`./reload.sh` automatically** (no need to ask first — it's a safe, local
rebuild+reinstall). Then tell the user to reload the window with Cmd+R
(**Developer: Reload Window**) to load the new build, since the window reload
can't be triggered from the CLI. Open the panel with **Waypoint: Open Plan
Viewer**.

```sh
./reload.sh
```

`reload.sh` builds, packages to a stable `waypoint.vsix`, and `--force`
reinstalls it. Using the fixed filename means **no version bump is needed for
ordinary feature work** — only bump `version` in `package.json` when you
specifically need VS Code to treat it as a distinct release (it can skip
reinstalling an identical version even with `--force`). The installed id is
`LudwigFelder.waypoint-plan-reviewer`.

- Do **not** rely on F5 for this feature — F5 launches a *separate* dev-host
  window and does not affect the window you work in.

### Gotcha that will waste your time

The installed copy lives at `~/.vscode/extensions/ludwigfelder.waypoint-plan-reviewer-<version>/`
and is what VS Code actually runs. Editing + `bun run build` only updates the
**workspace** `media/`/`out/` — the running extension keeps serving the old
build until you repackage and reinstall. Symptom we hit: a ` ```mermaid ` block
rendered as a plain code block with an hljs `Could not find the language
'mermaid'` warning, and the webview resource path pointed at
`~/.vscode/extensions/ludwigfelder.waypoint-plan-reviewer-*/media/webview.js`. If rendering looks
stale, confirm which `webview.js` is loaded before debugging code.

The webview also cache-busts its `webview.js`/`webview.css` URIs by file mtime
(`renderHtml` in `src/extension/extension.ts`), so a reinstalled bundle is not
served stale by the webview resource cache.
