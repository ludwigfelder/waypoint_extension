import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// The script the skills call as their last step. It is what stops the viewer's
// spinner, so its output shape is a contract with the extension host's
// `handleSignal`, not an implementation detail.
const SCRIPT = resolve(
  import.meta.dir,
  "../.claude/skills/waypoint/scripts/signal.py",
);

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
);

/** A repo-shaped temp dir with one plan in it. */
async function workspace(plans: string[] = ["a.md"]) {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-signal-"));
  dirs.push(dir);
  await mkdir(join(dir, ".waypoint", "plans"), { recursive: true });
  for (const name of plans) {
    await writeFile(join(dir, ".waypoint", "plans", name), "# Plan\n");
    // Distinct mtimes, so "newest" is well defined rather than a coin flip.
    await Bun.sleep(10);
  }
  return dir;
}

async function run(cwd: string, args: string[]) {
  const proc = Bun.spawn(["python3", SCRIPT, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { code, stderr };
}

const signal = (dir: string, slug: string) =>
  readFile(join(dir, ".waypoint", "signals", slug + ".json"), "utf8").then(JSON.parse);

describe("signal.py", () => {
  test("falls back to a pre-rename .galley/ workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-signal-legacy-"));
    dirs.push(dir);
    await mkdir(join(dir, ".galley", "plans"), { recursive: true });
    await writeFile(join(dir, ".galley", "plans", "a.md"), "# Plan\n");
    const { code } = await run(dir, ["apply_finished", "--changed"]);
    expect(code).toBe(0);
    const payload = JSON.parse(
      await readFile(join(dir, ".galley", "signals", "a.json"), "utf8"),
    );
    expect(payload).toMatchObject({ event: "apply_finished", plan: "a.md" });
  });

  test("writes the payload the host reads, and creates signals/ itself", async () => {
    const dir = await workspace();
    const { code } = await run(dir, ["apply_finished", "--plan", "a.md", "--changed"]);
    expect(code).toBe(0);
    const payload = await signal(dir, "a");
    expect(payload).toMatchObject({
      event: "apply_finished",
      plan: "a.md",
      changed: true,
    });
    expect(typeof payload.ts).toBe("number");
  });

  test("--no-changed is the case a file watcher cannot observe", async () => {
    const dir = await workspace();
    await run(dir, ["update_finished", "--plan", "a.md", "--no-changed"]);
    expect(await signal(dir, "a")).toMatchObject({
      event: "update_finished",
      changed: false,
    });
  });

  test("one signal per plan: a second run overwrites rather than queues", async () => {
    const dir = await workspace();
    await run(dir, ["apply_finished", "--plan", "a.md", "--changed"]);
    await run(dir, ["apply_finished", "--plan", "a.md", "--no-changed"]);
    expect((await signal(dir, "a")).changed).toBe(false);
  });

  test("with no --plan it picks the newest non-review plan, as tick.py does", async () => {
    const dir = await workspace(["old.md", "new.md"]);
    await writeFile(join(dir, ".waypoint", "plans", "new.review.md"), "review\n");
    await run(dir, ["apply_finished", "--changed"]);
    expect((await signal(dir, "new")).plan).toBe("new.md");
  });

  test("refuses an unknown plan and an unknown event rather than guessing", async () => {
    const dir = await workspace();
    const missing = await run(dir, ["apply_finished", "--plan", "nope.md", "--changed"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("no plan named");
    const badEvent = await run(dir, ["finished", "--plan", "a.md", "--changed"]);
    expect(badEvent.code).not.toBe(0);
  });

  test("requires an explicit changed/no-changed — the flag is never guessed", async () => {
    const dir = await workspace();
    const { code } = await run(dir, ["apply_finished", "--plan", "a.md"]);
    expect(code).not.toBe(0);
  });
});
