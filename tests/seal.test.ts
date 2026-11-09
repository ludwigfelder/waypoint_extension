import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PlanStore } from "../src/extension/planStore";

// The script /waypoint-update runs before its first write. Its output is a
// contract with PlanStore: what it seals must read back through the store as if
// the viewer's Send back had sealed it.
const SCRIPT = resolve(
  import.meta.dir,
  "../.agents/skills/waypoint-update/scripts/seal.py",
);

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
);

async function workspace(plan = "# Plan\n\nBody.\n") {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-seal-"));
  dirs.push(dir);
  const store = new PlanStore(join(dir, ".waypoint"));
  await store.init();
  await mkdir(store.plansDir, { recursive: true });
  await writeFile(join(store.plansDir, "a.md"), plan);
  return { dir, store };
}

async function run(cwd: string, args: string[]) {
  const proc = Bun.spawn(["python3", SCRIPT, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("seal.py", () => {
  test("falls back to a pre-rename .galley/ workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-seal-legacy-"));
    dirs.push(dir);
    const store = new PlanStore(join(dir, ".galley"));
    await store.init();
    await mkdir(store.plansDir, { recursive: true });
    await writeFile(join(store.plansDir, "a.md"), "# Plan\n");
    const { code } = await run(dir, ["--reason", "legacy dir"]);
    expect(code).toBe(0);
    expect(await store.listVersions("a.md")).toEqual([
      { n: 1, current: false, note: "legacy dir" },
      { n: 2, current: true },
    ]);
  });

  test("seals the plan as the next version, with the reason as its note", async () => {
    const { dir, store } = await workspace();
    const { code, stdout } = await run(dir, ["--plan", "a.md", "--reason", "gate C4 failed"]);
    expect(code).toBe(0);
    expect(stdout).toContain("v2");
    expect(await store.listVersions("a.md")).toEqual([
      { n: 1, current: false, note: "gate C4 failed" },
      { n: 2, current: true },
    ]);
    const past = await store.getVersion("a.md", 1);
    expect(past.markdown).toBe("# Plan\n\nBody.\n");
    expect(past.note).toBe("gate C4 failed");
    // The live plan is untouched: the rewrite is the agent's job, not the script's.
    expect(await store.getPlan("a.md")).toBe("# Plan\n\nBody.\n");
  });

  test("moves the active comments into the sealed version and clears the baseline", async () => {
    const { dir, store } = await workspace();
    await store.writeComments("a.md", [
      { id: "c1", quote: "Body.", start: 8, end: 13, body: "hm", createdAt: 1 },
    ]);
    await store.editText("a.md", 8, 13, "Body.", "Body!");
    expect(await store.readBaseline("a.md")).toBeTruthy();
    const { code } = await run(dir, ["--plan", "a.md", "--reason", "notes"]);
    expect(code).toBe(0);
    expect(await store.readComments("a.md")).toHaveLength(0);
    expect(await store.readBaseline("a.md")).toBe("");
    const past = await store.getVersion("a.md", 1);
    expect(past.comments).toHaveLength(1);
    expect(past.comments[0]).toMatchObject({ id: "c1", body: "hm", resolved: true });
  });

  test("with no comments it writes the same header-only file the store writes", async () => {
    const { dir, store } = await workspace();
    await run(dir, ["--plan", "a.md", "--reason", "notes"]);
    const scripted = await readFile(join(store.versionsDir, "a", "v1.comments.md"), "utf8");
    await writeFile(join(store.plansDir, "b.md"), "# B\n");
    await store.sealCurrent("b.md");
    const stored = await readFile(join(store.versionsDir, "b", "v1.comments.md"), "utf8");
    expect(scripted).toBe(stored.replace("slug=b", "slug=a"));
  });

  test("after the viewer's Reflect sealed the same text, it only records the reason", async () => {
    const { dir, store } = await workspace();
    await store.sealCurrent("a.md", "Reflect requested in the Waypoint viewer.");
    const { code, stdout } = await run(dir, ["--plan", "a.md", "--reason", "C4 failed"]);
    expect(code).toBe(0);
    expect(stdout).toContain("v2");
    expect((await readdir(join(store.versionsDir, "a"))).sort()).toEqual([
      "v1.comments.md",
      "v1.md",
      "v1.note.md",
    ]);
    expect(await store.readVersionNote("a.md", 1)).toBe("C4 failed");
  });

  test("a plan that changed since the last seal gets a fresh version", async () => {
    const { dir, store } = await workspace();
    await store.sealCurrent("a.md", "Sent back for revision.");
    await writeFile(join(store.plansDir, "a.md"), "# Plan\n\nRevised.\n");
    await run(dir, ["--plan", "a.md", "--reason", "second thoughts"]);
    expect((await store.listVersions("a.md")).map((v) => v.note)).toEqual([
      "Sent back for revision.",
      "second thoughts",
      undefined,
    ]);
    expect((await store.getVersion("a.md", 2)).markdown).toBe("# Plan\n\nRevised.\n");
  });

  test("the reason is required, non-empty, and one line", async () => {
    const { dir } = await workspace();
    expect((await run(dir, ["--plan", "a.md"])).code).not.toBe(0);
    expect((await run(dir, ["--plan", "a.md", "--reason", "  "])).code).not.toBe(0);
    const multi = await run(dir, ["--plan", "a.md", "--reason", "a\nb"]);
    expect(multi.code).not.toBe(0);
    expect(multi.stderr).toContain("single line");
  });

  test("with no --plan it picks the newest non-review plan, as the other scripts do", async () => {
    const { dir, store } = await workspace();
    await Bun.sleep(10);
    await writeFile(join(store.plansDir, "new.md"), "# New\n");
    await writeFile(join(store.plansDir, "new.review.md"), "review\n");
    await run(dir, ["--reason", "notes"]);
    expect(await store.listVersions("new.md")).toHaveLength(2);
    expect(await store.listVersions("a.md")).toHaveLength(1);
  });
});
