import { SveltePlugin } from "bun-plugin-svelte";
import tailwind from "bun-plugin-tailwind";
import { cp, readdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

async function buildExtension() {
  const res = await Bun.build({
    entrypoints: ["src/extension/extension.ts"],
    outdir: "out",
    target: "node",
    format: "cjs",
    external: ["vscode"],
    sourcemap: "linked",
  });
  if (!res.success) {
    console.error(res.logs);
    throw new Error("extension build failed");
  }
}

async function buildWebview() {
  const res = await Bun.build({
    entrypoints: ["src/webview/main.ts"],
    outdir: "media",
    naming: "webview.[ext]",
    target: "browser",
    minify: true,
    sourcemap: "linked",
    plugins: [SveltePlugin({ development: false }), tailwind],
  });
  if (!res.success) {
    console.error(res.logs);
    throw new Error("webview build failed");
  }
}

async function copyHljsThemes() {
  // Theme-switched at runtime by the webview based on the VS Code theme kind.
  await Bun.write(
    "media/hljs-dark.css",
    Bun.file("node_modules/highlight.js/styles/github-dark.css"),
  );
  await Bun.write(
    "media/hljs-light.css",
    Bun.file("node_modules/highlight.js/styles/github.css"),
  );
}

async function copyKit() {
  // The agent kit that "Install skills" copies into other repos. Bundled once
  // with an undotted dir name (.vscodeignore drops dotted dirs, and vsce is
  // fickle about them); skillsKit.ts fans each file out to `.agents/skills`
  // (read by Codex) and `.claude/skills` (read by Claude Code) on install.
  // Command wrappers are not shipped: Claude Code surfaces skills as slash
  // commands itself, so wrappers only double the `/`-menu entries.
  await rm("resources/kit", { recursive: true, force: true });
  const src = ".agents/skills";
  for (const name of await readdir(src)) {
    if (!name.startsWith("waypoint")) continue;
    await cp(`${src}/${name}`, `resources/kit/agents/skills/${name}`, {
      recursive: true,
    });
  }
}

async function buildAll() {
  await Promise.all([
    buildExtension(),
    buildWebview(),
    copyHljsThemes(),
    copyKit(),
  ]);
  console.log(
    "built: out/extension.js, media/webview.js, media/webview.css, media/hljs-*.css, resources/kit/",
  );
}

await buildAll();

if (watch) {
  console.log("watching src/ for changes…");
  const { watch: fsWatch } = await import("node:fs");
  let timer: ReturnType<typeof setTimeout> | undefined;
  fsWatch("src", { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => buildAll().catch((e) => console.error(e)), 150);
  });
}
