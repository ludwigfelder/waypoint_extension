// Installs the bundled Waypoint agent kit — the skills and slash commands the
// agents need in a repo before /waypoint works there — into a workspace, and
// adds the ignore block to .gitignore. Kept vscode-free so tests can exercise
// it directly; extension.ts owns workspace resolution and messaging.
import { join, dirname, sep } from "node:path";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

/**
 * Bundled top-level dir → real (dotted) dirs in the workspace. The kit ships
 * with undotted names (`.vscodeignore` drops `.claude/**`, and hidden dirs are
 * easy to lose in packaging); install restores the dots.
 *
 * The bundle carries one copy (under `agents/`) and install fans it out to one
 * dir per CLI: Codex reads `.agents/skills`, Claude Code reads `.claude/skills`
 * and ignores `.agents` (verified empirically on 2.1.229 — a skill present
 * only in `.agents/skills` does not appear in the Skill tool). This causes no
 * duplicate skill entries precisely because neither CLI reads the other's dir.
 */
const TARGET_DIRS: Record<string, string[]> = {
  agents: [".agents", ".claude"],
};

/** What the kit may ship: skill/command markdown plus helper scripts (tick.py). */
const KIT_EXTS = [".md", ".py"];

export const GITIGNORE_HEADER =
  "# Waypoint agent kit (installed by the Waypoint extension)";
export const GITIGNORE_ENTRIES = [
  ".claude/skills/waypoint*/",
  ".claude/commands/waypoint*.md",
  ".agents/skills/waypoint*/",
  ".waypoint/",
];

export type KitStatus = { missing: string[]; total: number };
export type KitInstallResult = {
  installed: string[];
  skipped: string[];
  /** Stale command wrappers from older kits, deleted by this install. */
  removed: string[];
  gitignore: "created" | "updated" | "unchanged";
};

type KitFile = { src: string; rel: string };

/** agents/skills/… → [.agents/skills/…, .claude/skills/…], "/"-separated. */
function targetRels(kitRel: string): string[] {
  const parts = kitRel.split(sep);
  const dirs = TARGET_DIRS[parts[0]] ?? [parts[0]];
  return dirs.map((d) => [d, ...parts.slice(1)].join("/"));
}

async function kitFiles(kitRoot: string): Promise<KitFile[]> {
  let entries: string[];
  try {
    entries = await readdir(kitRoot, { recursive: true });
  } catch {
    return []; // no bundled kit (stale build) — nothing to offer
  }
  return entries
    .filter((p) => KIT_EXTS.some((ext) => p.endsWith(ext)))
    .sort()
    .flatMap((p) =>
      targetRels(p).map((rel) => ({ src: join(kitRoot, p), rel })),
    );
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Which kit files the workspace is missing (paths relative to the repo root). */
export async function kitStatus(
  kitRoot: string,
  wsPath: string,
): Promise<KitStatus> {
  const files = await kitFiles(kitRoot);
  const missing: string[] = [];
  for (const f of files) {
    if (!(await exists(join(wsPath, ...f.rel.split("/"))))) missing.push(f.rel);
  }
  return { missing, total: files.length };
}

async function isSymlink(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Pre-rename kit prefix; still recognised so old installs get cleaned up. */
const LEGACY_PREFIX = "galley";

/** A kit entry name: the current prefix or the pre-rename one. */
function isKitName(name: string): boolean {
  return name.startsWith("waypoint") || name.startsWith(LEGACY_PREFIX);
}

/**
 * Delete the pre-rename `galley*` skill dirs so a workspace does not carry
 * two copies of every skill. Only the explicit install/reinstall actions ask
 * for this (`removeLegacy`), never the silent refresh on activation: a dev
 * checkout of an older branch tracks those dirs as source. A symlinked
 * `skills` dir, or a symlinked entry, is never followed or removed.
 */
async function removeLegacyKitDirs(wsPath: string): Promise<string[]> {
  const removed: string[] = [];
  for (const base of TARGET_DIRS.agents) {
    const skillsDir = join(wsPath, base, "skills");
    if (await isSymlink(skillsDir)) continue;
    let entries: string[] = [];
    try {
      entries = await readdir(skillsDir);
    } catch {}
    for (const name of entries.sort()) {
      if (!name.startsWith(LEGACY_PREFIX)) continue;
      const p = join(skillsDir, name);
      if (await isSymlink(p)) continue;
      await rm(p, { recursive: true, force: true });
      removed.push(`${base}/skills/${name}`);
    }
  }
  return removed;
}

/**
 * Delete the `waypoint*.md` (and pre-rename `galley*.md`) command wrappers
 * older kits installed. Claude Code
 * surfaces skills as slash commands itself (verified on 2.1.229: a skill in
 * `.claude/skills` resolves as `/waypoint` with no commands dir present), so
 * the wrappers only produce duplicate `/`-menu entries. A symlinked
 * `.claude/commands` (a dev-layout pointing at some source of truth) is never
 * followed — deleting through it would destroy the original.
 */
async function removeCommandWrappers(wsPath: string): Promise<string[]> {
  const removed: string[] = [];
  const commandsDir = join(wsPath, ".claude", "commands");
  if (await isSymlink(commandsDir)) return removed;
  let entries: string[] = [];
  try {
    entries = await readdir(commandsDir);
  } catch {}
  for (const name of entries.sort()) {
    if (!isKitName(name) || !name.endsWith(".md")) continue;
    await rm(join(commandsDir, name), { force: true });
    removed.push(`.claude/commands/${name}`);
  }
  return removed;
}

/**
 * Copy the kit files into the workspace, remove stale command wrappers, then
 * add the ignore block. With `force` (how the extension always installs — on
 * open, the install button, and "Reinstall Waypoint") existing files are
 * overwritten so the repo always tracks the bundled kit; without it, existing
 * files are skipped (used only by the pure-function tests).
 */
export type KitInstallOptions = {
  /** Also delete pre-rename `galley*` skill dirs (explicit actions only). */
  removeLegacy?: boolean;
};

export async function installKit(
  kitRoot: string,
  wsPath: string,
  force = false,
  options: KitInstallOptions = {},
): Promise<KitInstallResult> {
  const files = await kitFiles(kitRoot);
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const target = join(wsPath, ...f.rel.split("/"));
    if (!force && (await exists(target))) {
      skipped.push(f.rel);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(f.src));
    installed.push(f.rel);
  }
  // An empty kit (stale build) must leave the workspace untouched.
  const removed = files.length ? await removeCommandWrappers(wsPath) : [];
  if (files.length && options.removeLegacy) {
    removed.push(...(await removeLegacyKitDirs(wsPath)));
  }
  const gitignore = files.length ? await updateGitignore(wsPath) : "unchanged";
  return { installed, skipped, removed, gitignore };
}

/** Append the Waypoint block to .gitignore, adding only entries not already there. */
export async function updateGitignore(
  wsPath: string,
): Promise<"created" | "updated" | "unchanged"> {
  const path = join(wsPath, ".gitignore");
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch {}
  const have = new Set((existing ?? "").split("\n").map((l) => l.trim()));
  const toAdd = GITIGNORE_ENTRIES.filter((e) => !have.has(e));
  if (existing !== null && toAdd.length === 0) return "unchanged";
  const block = `${GITIGNORE_HEADER}\n${toAdd.join("\n")}\n`;
  if (existing === null) {
    await writeFile(path, block);
    return "created";
  }
  await writeFile(path, existing + (existing.endsWith("\n") ? "\n" : "\n\n") + block);
  return "updated";
}
