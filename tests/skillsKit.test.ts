import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  kitStatus,
  installKit,
  GITIGNORE_ENTRIES,
  GITIGNORE_HEADER,
} from "../src/extension/skillsKit";

let kit: string;
let ws: string;

// The bundle carries one copy under agents/; install fans each file out to
// .agents/skills (Codex) and .claude/skills (Claude Code).
const KIT_FILES = [
  "agents/skills/waypoint/SKILL.md",
  "agents/skills/waypoint-implement/SKILL.md",
  "agents/skills/waypoint/scripts/tick.py",
];
const TARGETS_PER_FILE = 2;
const TARGET_COUNT = KIT_FILES.length * TARGETS_PER_FILE;

beforeEach(async () => {
  kit = await mkdtemp(join(tmpdir(), "waypoint-kit-"));
  ws = await mkdtemp(join(tmpdir(), "waypoint-ws-"));
  for (const f of KIT_FILES) {
    await mkdir(dirname(join(kit, f)), { recursive: true });
    await writeFile(join(kit, f), `kit content of ${f}\n`);
  }
});

afterEach(async () => {
  await rm(kit, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
});

describe("kitStatus", () => {
  test("reports every fan-out target missing in a fresh repo, with dotted dirs", async () => {
    const s = await kitStatus(kit, ws);
    expect(s.total).toBe(TARGET_COUNT);
    expect(s.missing.sort()).toEqual([
      ".agents/skills/waypoint-implement/SKILL.md",
      ".agents/skills/waypoint/SKILL.md",
      ".agents/skills/waypoint/scripts/tick.py",
      ".claude/skills/waypoint-implement/SKILL.md",
      ".claude/skills/waypoint/SKILL.md",
      ".claude/skills/waypoint/scripts/tick.py",
    ]);
  });

  test("non-allowlisted kit files are neither counted nor installed", async () => {
    await writeFile(join(kit, "agents/skills/waypoint/notes.txt"), "scratch\n");
    const s = await kitStatus(kit, ws);
    expect(s.total).toBe(TARGET_COUNT);
    const res = await installKit(kit, ws);
    expect(res.installed.length).toBe(TARGET_COUNT);
    await expect(
      readFile(join(ws, ".agents/skills/waypoint/notes.txt"), "utf8"),
    ).rejects.toThrow();
  });

  test("a missing kit dir (stale build) yields an empty status", async () => {
    const s = await kitStatus(join(kit, "nope"), ws);
    expect(s).toEqual({ missing: [], total: 0 });
  });
});

describe("installKit", () => {
  test("copies each file into both dotted dirs and creates .gitignore", async () => {
    const res = await installKit(kit, ws);
    expect(res.installed.length).toBe(TARGET_COUNT);
    expect(res.skipped).toEqual([]);
    expect(res.removed).toEqual([]);
    expect(res.gitignore).toBe("created");

    for (const dir of [".agents", ".claude"]) {
      const skill = await readFile(
        join(ws, dir, "skills/waypoint/SKILL.md"),
        "utf8",
      );
      expect(skill).toBe("kit content of agents/skills/waypoint/SKILL.md\n");
    }

    const ignore = await readFile(join(ws, ".gitignore"), "utf8");
    expect(ignore).toContain(GITIGNORE_HEADER);
    for (const entry of GITIGNORE_ENTRIES) expect(ignore).toContain(entry);

    expect((await kitStatus(kit, ws)).missing).toEqual([]);
  });

  test("never overwrites an existing file", async () => {
    const target = join(ws, ".claude/skills/waypoint/SKILL.md");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "local edits\n");

    const res = await installKit(kit, ws);
    expect(res.skipped).toEqual([".claude/skills/waypoint/SKILL.md"]);
    expect(res.installed.length).toBe(TARGET_COUNT - 1);
    expect(await readFile(target, "utf8")).toBe("local edits\n");
  });

  test("force (Reinstall Waypoint) overwrites existing files", async () => {
    const target = join(ws, ".claude/skills/waypoint/SKILL.md");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "local edits\n");

    const res = await installKit(kit, ws, true);
    expect(res.skipped).toEqual([]);
    expect(res.installed.length).toBe(TARGET_COUNT);
    expect(await readFile(target, "utf8")).toBe(
      "kit content of agents/skills/waypoint/SKILL.md\n",
    );
  });

  test("appends only the missing ignore entries and is then idempotent", async () => {
    // Pre-existing .gitignore without a trailing newline, already covering one
    // kit entry.
    await writeFile(join(ws, ".gitignore"), "node_modules/\n.waypoint/");

    const res = await installKit(kit, ws);
    expect(res.gitignore).toBe("updated");
    const ignore = await readFile(join(ws, ".gitignore"), "utf8");
    expect(ignore.startsWith("node_modules/\n.waypoint/\n")).toBe(true);
    expect(ignore).toContain(".agents/skills/waypoint*/");
    expect(ignore).toContain(".claude/skills/waypoint*/");
    expect(ignore.split("\n").filter((l) => l.trim() === ".waypoint/").length).toBe(1);

    const again = await installKit(kit, ws);
    expect(again.installed).toEqual([]);
    expect(again.skipped.length).toBe(TARGET_COUNT);
    expect(again.gitignore).toBe("unchanged");
    expect(await readFile(join(ws, ".gitignore"), "utf8")).toBe(ignore);
  });

  test("an empty kit leaves the workspace untouched", async () => {
    // Even a stale command wrapper stays: a stale build must not mutate the repo.
    const stale = join(ws, ".claude/commands/waypoint.md");
    await mkdir(dirname(stale), { recursive: true });
    await writeFile(stale, "old wrapper\n");

    const res = await installKit(join(kit, "nope"), ws);
    expect(res).toEqual({
      installed: [],
      skipped: [],
      removed: [],
      gitignore: "unchanged",
    });
    await expect(readFile(join(ws, ".gitignore"), "utf8")).rejects.toThrow();
    expect(await readFile(stale, "utf8")).toBe("old wrapper\n");
  });

  test("removes stale command wrappers, keeps skills and foreign commands", async () => {
    for (const f of [
      // Pre-rename wrappers and current-name ones are both ours.
      ".claude/commands/galley.md",
      ".claude/commands/waypoint-implement.md",
      // Not ours: a user command that shares the dir.
      ".claude/commands/deploy.md",
    ]) {
      await mkdir(dirname(join(ws, f)), { recursive: true });
      await writeFile(join(ws, f), `old ${f}\n`);
    }

    const res = await installKit(kit, ws, true);
    expect(res.removed.sort()).toEqual([
      ".claude/commands/galley.md",
      ".claude/commands/waypoint-implement.md",
    ]);
    await expect(
      readFile(join(ws, ".claude/commands/galley.md"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(join(ws, ".claude/commands/deploy.md"), "utf8")).toBe(
      "old .claude/commands/deploy.md\n",
    );
    // The freshly installed .claude skills are untouched by the cleanup.
    expect(
      await readFile(join(ws, ".claude/skills/waypoint/SKILL.md"), "utf8"),
    ).toBe("kit content of agents/skills/waypoint/SKILL.md\n");
  });

  test("never deletes through a symlinked .claude/commands", async () => {
    // A dev layout may keep .claude/commands pointing at a tracked source dir;
    // following the link would delete the originals.
    const real = join(ws, "commands-src");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "galley.md"), "source wrapper\n");
    await mkdir(join(ws, ".claude"), { recursive: true });
    await symlink(join("..", "commands-src"), join(ws, ".claude/commands"));

    const res = await installKit(kit, ws, true);
    expect(res.removed).toEqual([]);
    expect(await readFile(join(real, "galley.md"), "utf8")).toBe(
      "source wrapper\n",
    );
  });

  test("a symlinked .claude/skills (dev-repo layout) is written through, not duplicated", async () => {
    // The Waypoint repo symlinks .claude/skills -> .agents/skills; installing
    // through it must land the same content, not error.
    await mkdir(join(ws, ".agents/skills"), { recursive: true });
    await mkdir(join(ws, ".claude"), { recursive: true });
    await symlink(join("..", ".agents", "skills"), join(ws, ".claude/skills"));

    const res = await installKit(kit, ws, true);
    expect(res.installed.length).toBe(TARGET_COUNT);
    expect(
      await readFile(join(ws, ".agents/skills/waypoint/SKILL.md"), "utf8"),
    ).toBe("kit content of agents/skills/waypoint/SKILL.md\n");
  });
});

describe("installKit removeLegacy (pre-rename galley* skill dirs)", () => {
  async function legacyDirs() {
    for (const f of [
      ".agents/skills/galley/SKILL.md",
      ".claude/skills/galley-apply/SKILL.md",
      // Not ours: a user skill that shares the dir.
      ".agents/skills/deploy/SKILL.md",
    ]) {
      await mkdir(dirname(join(ws, f)), { recursive: true });
      await writeFile(join(ws, f), `old ${f}\n`);
    }
  }

  test("removes real legacy dirs on both sides, keeps foreign skills", async () => {
    await legacyDirs();
    const res = await installKit(kit, ws, true, { removeLegacy: true });
    expect(res.removed).toEqual([
      ".agents/skills/galley",
      ".claude/skills/galley-apply",
    ]);
    await expect(
      readFile(join(ws, ".agents/skills/galley/SKILL.md"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(ws, ".claude/skills/galley-apply/SKILL.md"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(join(ws, ".agents/skills/deploy/SKILL.md"), "utf8")).toBe(
      "old .agents/skills/deploy/SKILL.md\n",
    );
    expect(await readFile(join(ws, ".claude/skills/waypoint/SKILL.md"), "utf8")).toBe(
      "kit content of agents/skills/waypoint/SKILL.md\n",
    );
  });

  test("is off by default: the silent refresh never deletes", async () => {
    await legacyDirs();
    const res = await installKit(kit, ws, true);
    expect(res.removed).toEqual([]);
    expect(await readFile(join(ws, ".agents/skills/galley/SKILL.md"), "utf8")).toBe(
      "old .agents/skills/galley/SKILL.md\n",
    );
  });

  test("never follows a symlinked skills dir or a symlinked entry", async () => {
    // Dev layout: .claude/skills -> ../.agents/skills, plus one legacy entry
    // that is itself a link to a source dir elsewhere.
    const src = join(ws, "skill-src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), "source skill\n");
    await mkdir(join(ws, ".agents/skills/galley"), { recursive: true });
    await writeFile(join(ws, ".agents/skills/galley/SKILL.md"), "real legacy\n");
    await symlink(join("..", "..", "skill-src"), join(ws, ".agents/skills/galley-linked"));
    await mkdir(join(ws, ".claude"), { recursive: true });
    await symlink(join("..", ".agents", "skills"), join(ws, ".claude/skills"));

    const res = await installKit(kit, ws, true, { removeLegacy: true });
    // The real dir goes once (via .agents), the link and its target survive,
    // and the symlinked .claude side is skipped rather than double-counted.
    expect(res.removed).toEqual([".agents/skills/galley"]);
    expect(await readFile(join(src, "SKILL.md"), "utf8")).toBe("source skill\n");
    expect(
      await readFile(join(ws, ".agents/skills/galley-linked/SKILL.md"), "utf8"),
    ).toBe("source skill\n");
  });
});
