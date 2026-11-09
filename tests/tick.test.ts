import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TICK = join(import.meta.dir, "../.agents/skills/waypoint/scripts/tick.py");

const PLAN = `# Auth plan

## Phase 1: Login

Body text.

### Phase 1 acceptance gate

:::checklist
- [ ] #C1 \`bun test\` exits 0.
- [ ] #C2 \`./smoke.sh\` prints \`401\`.
- [ ] #C3 @human The login page reads well.
:::

## Phase 2: Sessions

### Phase 2 acceptance gate

:::checklist
- [ ] #C4 \`bun run typecheck\` exits 0.
:::

## Verification

An example gate in a fenced block must stay inert:

\`\`\`
:::checklist
- [ ] #C1 decoy in a fenced example.
- [ ] #C9 exists only inside this fence.
:::
\`\`\`
`;

const dirs: string[] = [];

async function repo(plan = PLAN, name = "auth.md"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-tick-"));
  dirs.push(dir);
  await mkdir(join(dir, ".waypoint/plans"), { recursive: true });
  await writeFile(join(dir, ".waypoint/plans", name), plan);
  return dir;
}

function run(dir: string, ...args: string[]) {
  const p = Bun.spawnSync(["python3", TICK, ...args], { cwd: dir });
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
}

const plan = (dir: string, name = "auth.md") =>
  readFile(join(dir, ".waypoint/plans", name), "utf8");

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("tick.py", () => {
  test("falls back to a pre-rename .galley/plans dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-tick-legacy-"));
    dirs.push(dir);
    await mkdir(join(dir, ".galley/plans"), { recursive: true });
    await writeFile(join(dir, ".galley/plans/auth.md"), PLAN);
    const r = run(dir, "C1", "--evidence", "bun test exited 0");
    expect(r.code).toBe(0);
    expect(await readFile(join(dir, ".galley/plans/auth.md"), "utf8")).toContain(
      "- [x] #C1",
    );
  });

  test("ticks by ID, inserting evidence under the criterion, changing nothing else", async () => {
    const dir = await repo();
    const r = run(dir, "C1", "--evidence", "bun test exited 0");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    // Byte-equality: marker flip + one inserted line, decoy untouched,
    // trailing newline preserved.
    expect(await plan(dir)).toBe(
      PLAN.replace(
        "- [ ] #C1 `bun test` exits 0.",
        "- [x] #C1 `bun test` exits 0.\n  evidence: bun test exited 0",
      ),
    );
    expect(r.out).toContain("ticked: #C1");
    expect(r.out).toContain("phase 1 remaining: #C2, #C3(@human)");
  });

  test("accepts a leading # on the ID", async () => {
    const dir = await repo();
    expect(run(dir, "#C1", "--evidence", "ok").code).toBe(0);
    expect(await plan(dir)).toContain("- [x] #C1");
  });

  test("reports the gate green when the last criterion of a phase is ticked", async () => {
    const dir = await repo();
    const r = run(dir, "C4", "--evidence", "typecheck exited 0");
    expect(r.code).toBe(0);
    expect(r.out).toContain("phase 2 gate: all criteria ticked");
  });

  test("refuses @human criteria and leaves the file untouched", async () => {
    const dir = await repo();
    const r = run(dir, "C3", "--evidence", "looks fine");
    expect(r.code).toBe(1);
    expect(r.err).toContain("@human");
    expect(await plan(dir)).toBe(PLAN);
  });

  test("refuses duplicate IDs, naming both lines", async () => {
    const dup = PLAN.replace("#C2", "#C1");
    const dir = await repo(dup);
    const r = run(dir, "C1", "--evidence", "ok");
    expect(r.code).toBe(1);
    expect(r.err).toContain("duplicate");
    expect(r.err).toContain("lines 10, 11");
    expect(await plan(dir)).toBe(dup);
  });

  test("unknown ID errors with the plan's unticked IDs; fenced decoys are invisible", async () => {
    const dir = await repo();
    const r = run(dir, "C9", "--evidence", "ok");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no criterion #C9");
    expect(r.err).toContain("phase 1: #C1, #C2, #C3(@human)");
    expect(r.err).toContain("phase 2: #C4");
    expect(await plan(dir)).toBe(PLAN);
  });

  test("is idempotent: a second identical tick changes nothing", async () => {
    const dir = await repo();
    run(dir, "C1", "--evidence", "bun test exited 0");
    const after = await plan(dir);
    const r = run(dir, "C1", "--evidence", "bun test exited 0");
    expect(r.code).toBe(0);
    expect(r.out).toContain("already ticked");
    expect(await plan(dir)).toBe(after);
  });

  test("repairs an asserted tick by inserting the missing evidence line", async () => {
    const asserted = PLAN.replace("- [ ] #C1", "- [x] #C1");
    const dir = await repo(asserted);
    const r = run(dir, "C1", "--evidence", "bun test exited 0");
    expect(r.code).toBe(0);
    expect(await plan(dir)).toBe(
      asserted.replace(
        "- [x] #C1 `bun test` exits 0.",
        "- [x] #C1 `bun test` exits 0.\n  evidence: bun test exited 0",
      ),
    );
  });

  test("--override ticks the box and records the reason line", async () => {
    const dir = await repo();
    const r = run(dir, "C2", "--override", "flaky upstream; accepted by user");
    expect(r.code).toBe(0);
    expect(await plan(dir)).toContain(
      "- [x] #C2 `./smoke.sh` prints `401`.\n  override: flaky upstream; accepted by user",
    );
  });

  test("requires exactly one of --evidence/--override", async () => {
    const dir = await repo();
    expect(run(dir, "C1").code).toBe(2);
    expect(run(dir, "C1", "--evidence", "a", "--override", "b").code).toBe(2);
    expect(await plan(dir)).toBe(PLAN);
  });

  test("rejects multiline and empty evidence", async () => {
    const dir = await repo();
    expect(run(dir, "C1", "--evidence", "a\nb").code).toBe(1);
    expect(run(dir, "C1", "--evidence", "  ").code).toBe(1);
    expect(await plan(dir)).toBe(PLAN);
  });

  test("defaults to the newest non-review plan; --plan overrides", async () => {
    const dir = await repo(PLAN, "old.md");
    const plans = join(dir, ".waypoint/plans");
    await writeFile(join(plans, "new.md"), PLAN);
    await writeFile(join(plans, "newest.review.md"), PLAN);
    const past = new Date(Date.now() - 60_000);
    await utimes(join(plans, "old.md"), past, past);

    expect(run(dir, "C1", "--evidence", "ok").code).toBe(0);
    expect(await plan(dir, "new.md")).toContain("- [x] #C1");
    expect(await plan(dir, "old.md")).toBe(PLAN);
    expect(await plan(dir, "newest.review.md")).toBe(PLAN);

    expect(run(dir, "C1", "--plan", "old", "--evidence", "ok").code).toBe(0);
    expect(await plan(dir, "old.md")).toContain("- [x] #C1");
  });
});
