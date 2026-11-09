import { join, resolve } from "node:path";
import {
  readdir,
  stat,
  readFile,
  writeFile,
  mkdir,
  rename,
  rm,
} from "node:fs/promises";
import {
  compileReview,
  type Comment,
  type VersionInfo,
} from "../shared/review";
import { diffPlanEdits, type PlanEdit } from "../shared/planEdits";
import { scanChecklist } from "../shared/checklist";

export type Plan = { name: string; mtimeMs: number };

const isReview = (n: string) => n.endsWith(".review.md");
const stemOf = (name: string) => name.replace(/\.md$/, "");

/* ---- comment .md (de)serialization — human-readable + machine-parseable ---- */

function formatComments(stem: string, version: number, comments: Comment[]) {
  let out = `<!-- waypoint:comments slug=${stem} version=${version} -->\n`;
  for (const c of comments) {
    // Verdict/cross-cutting records carry their extras as k=v pairs on the
    // header line. Older builds ignore unknown extras (verdict-less records
    // from before the extras era are the only downgrade hazard).
    let extras =
      c.kind === "verdict"
        ? ` kind=verdict verdict=${c.verdict} callout=${c.callout}`
        : "";
    if (c.crossCutting) extras += " cross=1";
    if (c.stale) extras += " stale=1";
    out += `\n<!-- c id=${c.id} start=${c.start} end=${c.end} created=${c.createdAt}${extras} -->\n`;
    for (const line of c.quote.split("\n")) out += `> ${line}\n`;
    out += `\n${c.body}\n`;
  }
  return out;
}

function parseComments(md: string, resolved: boolean): Comment[] {
  const out: Comment[] = [];
  const parts = md.split(/<!-- c /).slice(1);
  for (const part of parts) {
    // Trailing `k=v` extras are optional, so files from older builds (no
    // extras) keep parsing unchanged.
    const m =
      /^id=(\S+) start=(\d+) end=(\d+) created=(\d+)((?: [a-z]+=\S+)*) -->\n([\s\S]*)$/.exec(
        part,
      );
    if (!m) continue;
    const [, id, start, end, created, extraStr, rest] = m;
    const extras: Record<string, string> = {};
    for (const kv of extraStr.trim().split(/\s+/).filter(Boolean)) {
      const eq = kv.indexOf("=");
      if (eq > 0) extras[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    const lines = rest.split("\n");
    const quote: string[] = [];
    let i = 0;
    while (i < lines.length && lines[i].startsWith(">")) {
      quote.push(lines[i].replace(/^>\s?/, ""));
      i++;
    }
    while (i < lines.length && lines[i].trim() === "") i++;
    const body = lines.slice(i).join("\n").trim();
    const comment: Comment = {
      id,
      start: +start,
      end: +end,
      createdAt: +created,
      quote: quote.join("\n"),
      body,
      resolved,
    };
    if (
      extras.kind === "verdict" &&
      (extras.verdict === "accept" || extras.verdict === "reject") &&
      extras.callout
    ) {
      comment.kind = "verdict";
      comment.verdict = extras.verdict;
      comment.callout = extras.callout;
    }
    if (extras.cross === "1") comment.crossCutting = true;
    if (extras.stale === "1") comment.stale = true;
    out.push(comment);
  }
  return out;
}

/**
 * Filesystem store. Each plan has a live `<slug>.md` (the current version) plus
 * sealed snapshots under `versions/<slug>/v<N>.md` + `v<N>.comments.md`. Active
 * comments live in `plans/.comments/<slug>.md` and are deleted when emptied.
 */
export class PlanStore {
  readonly plansDir: string;
  readonly commentsDir: string;
  readonly versionsDir: string;
  readonly editsDir: string;

  constructor(waypointDir: string) {
    this.plansDir = join(waypointDir, "plans");
    this.commentsDir = join(this.plansDir, ".comments");
    this.versionsDir = join(waypointDir, "versions");
    // Edit-session baselines. Like .comments/ this lives inside plansDir, whose
    // watcher pattern is non-recursive — writing here never trips a reload.
    this.editsDir = join(this.plansDir, ".edits");
  }

  async init() {
    await mkdir(this.commentsDir, { recursive: true });
  }

  safeName(name: string): boolean {
    return /^[\w.\- ]+\.md$/.test(name);
  }

  /* ---------------- plans ---------------- */

  async listPlans(): Promise<Plan[]> {
    let entries: string[];
    try {
      entries = await readdir(this.plansDir);
    } catch {
      return [];
    }
    const md = entries.filter((n) => n.endsWith(".md") && !isReview(n));
    const out = await Promise.all(
      md.map(async (name) => ({
        name,
        mtimeMs: (await stat(join(this.plansDir, name))).mtimeMs,
      })),
    );
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  private planPath(name: string): string {
    const p = resolve(this.plansDir, name);
    if (!p.startsWith(resolve(this.plansDir) + "/")) throw new Error("bad name");
    return p;
  }

  async getPlan(name: string): Promise<string> {
    if (!this.safeName(name)) throw new Error("bad name");
    return readFile(this.planPath(name), "utf8");
  }

  /* ---------------- active comments (current version) ---------------- */

  private commentsPath(name: string): string {
    return join(this.commentsDir, stemOf(name) + ".md");
  }

  async readComments(name: string): Promise<Comment[]> {
    if (!this.safeName(name)) return [];
    try {
      return parseComments(await readFile(this.commentsPath(name), "utf8"), false);
    } catch {
      return [];
    }
  }

  async writeComments(name: string, comments: Comment[]) {
    if (!this.safeName(name)) return;
    const path = this.commentsPath(name);
    if (!comments.length) {
      await rm(path, { force: true }); // delete the file when no comments remain
      return;
    }
    const version = await this.currentVersion(name);
    await writeFile(path, formatComments(stemOf(name), version, comments));
  }

  /* ---------------- versions ---------------- */

  private sealedDir(name: string): string {
    return join(this.versionsDir, stemOf(name));
  }

  private async maxSealed(name: string): Promise<number> {
    try {
      const files = await readdir(this.sealedDir(name));
      const ns = files
        .map((f) => /^v(\d+)\.md$/.exec(f))
        .filter(Boolean)
        .map((m) => +m![1]);
      return ns.length ? Math.max(...ns) : 0;
    } catch {
      return 0;
    }
  }

  /** Current (live, editable) version number = sealed count + 1. */
  async currentVersion(name: string): Promise<number> {
    return (await this.maxSealed(name)) + 1;
  }

  /** Public read-only version lookup for interaction metadata. */
  async getCurrentVersion(name: string): Promise<number> {
    if (!this.safeName(name)) throw new Error("bad name");
    return this.currentVersion(name);
  }

  async listVersions(name: string): Promise<VersionInfo[]> {
    const current = await this.currentVersion(name);
    return Promise.all(
      Array.from({ length: current }, async (_, i) => {
        const n = i + 1;
        const info: VersionInfo = { n, current: n === current };
        const note = n < current ? await this.readVersionNote(name, n) : "";
        if (note) info.note = note;
        return info;
      }),
    );
  }

  /** Load a version's plan text + comments. Sealed versions are resolved + read-only. */
  async getVersion(
    name: string,
    n: number,
  ): Promise<{
    version: number;
    current: boolean;
    markdown: string;
    comments: Comment[];
    note?: string;
  }> {
    const current = await this.currentVersion(name);
    if (n >= current) {
      return {
        version: current,
        current: true,
        markdown: await this.getPlan(name),
        comments: await this.readComments(name),
      };
    }
    const dir = this.sealedDir(name);
    const markdown = await readFile(join(dir, `v${n}.md`), "utf8").catch(() => "");
    const cmd = await readFile(join(dir, `v${n}.comments.md`), "utf8").catch(
      () => "",
    );
    const note = await this.readVersionNote(name, n);
    return {
      version: n,
      current: false,
      markdown,
      comments: parseComments(cmd, true),
      ...(note ? { note } : {}),
    };
  }

  /**
   * Why a sealed version was superseded: `versions/<slug>/v<n>.note.md`, one
   * line, written when the version is sealed. Three writers share the format —
   * `sealCurrent` for the viewer's Send back and Reflect, and the update
   * skill's `seal.py` for a hand-run `/waypoint-update`. Empty when a version
   * predates notes.
   */
  async readVersionNote(name: string, n: number): Promise<string> {
    if (!this.safeName(name)) return "";
    try {
      return (
        await readFile(join(this.sealedDir(name), `v${n}.note.md`), "utf8")
      ).trim();
    } catch {
      return "";
    }
  }

  async writeVersionNote(name: string, n: number, note: string) {
    if (!this.safeName(name)) throw new Error("bad name");
    const dir = this.sealedDir(name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `v${n}.note.md`), note.trim() + "\n");
  }

  /**
   * Snapshot the current plan + its comments as a sealed version; clear active.
   * `note` is the one-line reason the version is being closed, kept beside the
   * snapshot so the history can be read later without the interaction log.
   */
  async sealCurrent(name: string, note = ""): Promise<number> {
    const v = await this.currentVersion(name);
    const dir = this.sealedDir(name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `v${v}.md`), await this.getPlan(name));
    const comments = await this.readComments(name);
    await writeFile(
      join(dir, `v${v}.comments.md`),
      formatComments(stemOf(name), v, comments),
    );
    await rm(this.commentsPath(name), { force: true });
    // Sealing closes the review round, so the redline baseline goes with the
    // comments: the next version starts clean and accumulates its own edits.
    await this.clearBaseline(name);
    if (note.trim()) await this.writeVersionNote(name, v, note);
    return v;
  }

  /* ---------------- inline text editing ---------------- */

  private baselinePath(name: string): string {
    return join(this.editsDir, stemOf(name) + ".base.md");
  }

  /**
   * The plan as it stood when this round of edits began, or "" if the reviewer
   * has not edited since the last seal. The viewer redlines the live document
   * against it, so additions and deletions stay visible across re-renders
   * without any suggestion markup ever touching the plan file.
   */
  async readBaseline(name: string): Promise<string> {
    if (!this.safeName(name)) return "";
    try {
      return await readFile(this.baselinePath(name), "utf8");
    } catch {
      return "";
    }
  }

  async clearBaseline(name: string) {
    if (!this.safeName(name)) return;
    await rm(this.baselinePath(name), { force: true });
  }

  /**
   * Snapshot the pre-edit plan as this round's redline baseline, once per round.
   * Every reviewer-side write to the plan file goes through here first, so the
   * baseline is what the whole round of edits is measured against: the viewer's
   * redline and the review file's edit list both read from it.
   */
  private async ensureBaseline(name: string, before: string) {
    if (await this.readBaseline(name)) return;
    await mkdir(this.editsDir, { recursive: true });
    await writeFile(this.baselinePath(name), before);
  }

  /** The reviewer's direct changes to the plan this round: prose and gates. */
  async planEdits(name: string): Promise<PlanEdit[]> {
    const baseline = await this.readBaseline(name);
    if (!baseline) return [];
    return diffPlanEdits(baseline, await this.getPlan(name));
  }

  /**
   * Replace `[start, end)` of the live plan file with `text`. `expected` is what
   * the viewer believes is there; a mismatch means an agent (or another edit)
   * wrote underneath, so the edit is refused and the caller re-syncs from the
   * file. The first edit of a round snapshots the pre-edit plan as this plan's
   * redline baseline.
   *
   * Splices, not rewrites: every other reader of the file (parsePhases,
   * computeDrift, tick.py, the implement/update skills) sees a plan whose
   * untouched bytes are untouched.
   */
  async editText(
    name: string,
    start: number,
    end: number,
    expected: string,
    text: string,
  ): Promise<{ ok: boolean; markdown: string }> {
    if (!this.safeName(name)) throw new Error("bad name");
    const path = this.planPath(name);
    const before = await readFile(path, "utf8");
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > before.length ||
      before.slice(start, end) !== expected
    ) {
      return { ok: false, markdown: before };
    }
    await this.ensureBaseline(name, before);
    const markdown = before.slice(0, start) + text + before.slice(end);
    await writeFile(path, markdown);
    return { ok: true, markdown };
  }

  /* ---------------- checklist write-through ---------------- */

  /**
   * Edit the `ord`-th (0-based, document-order) `:::checklist` block of the
   * live plan file. `add` inserts `- [ ] <text>` before the block's closing
   * `:::`; `remove` deletes the first criterion line whose text equals `text`;
   * `set` flips that line's checkbox to `checked`. Matching is against the
   * raw criterion text (including any `@human ` marker). Returns false when
   * the block or line cannot be found (the plan changed underneath) — the
   * viewer's re-render then reflects whatever the file actually says.
   *
   * `add` and `remove` change what the plan demands, so like an inline prose
   * edit they open (or extend) the round's redline baseline and reach the agent
   * through the review file. `set` does not: ticking a box is the reviewer
   * signing off on an `@human` criterion, not a request to revise the plan.
   */
  async editChecklist(
    name: string,
    ord: number,
    action: "add" | "remove" | "set",
    text: string,
    checked = false,
  ): Promise<boolean> {
    if (!this.safeName(name)) throw new Error("bad name");
    if (!Number.isInteger(ord) || ord < 0 || !text) return false;
    const path = this.planPath(name);
    const before = await readFile(path, "utf8");
    const lines = before.split("\n");
    let idx = -1;
    let open = -1;
    let close = -1;
    for (let i = 0; i < lines.length && close === -1; i++) {
      if (open === -1) {
        if (/^:::checklist/.test(lines[i]) && ++idx === ord) open = i;
      } else if (/^:::\s*$/.test(lines[i])) {
        close = i;
      }
    }
    if (open === -1 || close === -1) return false;
    if (action === "add") {
      lines.splice(close, 0, `- [ ] ${text}`);
    } else {
      // Criteria may wrap across lines, so match the joined text the viewer
      // shows rather than a single source line — otherwise a wrapped criterion
      // can be displayed but never addressed.
      const hit = scanChecklist(lines.slice(open + 1, close).join("\n")).find(
        (c) => c.raw === text,
      );
      if (!hit) return false;
      const at = open + 1 + hit.lineStart;
      if (action === "remove") {
        // Take the criterion's wrapped lines and any trailing `override:` /
        // `evidence:` lines with it, so neither is orphaned onto the neighbor
        // above.
        lines.splice(at, hit.lineSpan + hit.noteSpan);
      } else {
        // Ticking flips the box on the opening line and leaves the wrapping
        // alone: it signs off on a criterion, it does not rewrite one.
        lines[at] = lines[at].replace(
          /^(\s*-\s*\[)[ xX](\])/,
          `$1${checked ? "x" : " "}$2`,
        );
      }
    }
    if (action !== "set") await this.ensureBaseline(name, before);
    await writeFile(path, lines.join("\n"));
    return true;
  }

  /* ---------------- review handoff ---------------- */

  /**
   * Retire an applied review file into the sealed version it belongs to, as
   * `versions/<slug>/v<n>.review.md` beside that round's `v<n>.md` and
   * `v<n>.comments.md`.
   *
   * The reviewer's compiled request is the one artifact of a round that nothing
   * else preserves: the interaction log is content-free, and `sealCurrent`
   * clears the baseline the `## Direct plan edits` section was derived from. So
   * it is moved, not deleted — and moved by the extension that wrote it, which
   * keeps `rm` out of the agent's hands entirely.
   *
   * Returns the archive path, or null when there was nothing to move.
   */
  async archiveReview(name: string, version: number): Promise<string | null> {
    if (!this.safeName(name)) throw new Error("bad name");
    const from = join(this.plansDir, stemOf(name) + ".review.md");
    const dir = this.sealedDir(name);
    const to = join(dir, `v${version}.review.md`);
    await mkdir(dir, { recursive: true });
    try {
      await rename(from, to);
    } catch (err: any) {
      // Already archived, or never written: a no-op, so a second call is safe.
      if (err?.code === "ENOENT") return null;
      // Different filesystem (a mounted workspace): copy, then drop the source.
      if (err?.code !== "EXDEV") throw err;
      await writeFile(to, await readFile(from, "utf8"));
      await rm(from, { force: true });
    }
    return to;
  }

  async writeReview(
    name: string,
  ): Promise<{ path: string; prompt: string; edits: PlanEdit[] }> {
    if (!this.safeName(name)) throw new Error("bad name");
    const comments = await this.readComments(name);
    // Read the edits before sealing: sealCurrent clears the baseline they are
    // derived from.
    const edits = await this.planEdits(name);
    const prompt = compileReview(name, comments, edits);
    const path = join(this.plansDir, stemOf(name) + ".review.md");
    await writeFile(path, prompt);
    return { path, prompt, edits };
  }
}
