import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFileRef } from "../src/shared/refs";
import {
  isBareName,
  refKey,
  resolveDirect,
  resolveInsideRoot,
} from "../src/extension/refs";

describe("parseFileRef", () => {
  test("accepts the path shapes plans actually write", () => {
    expect(parseFileRef("src/extension/planStore.ts")).toEqual({
      path: "src/extension/planStore.ts",
    });
    expect(parseFileRef("src/extension/planStore.ts:42")).toEqual({
      path: "src/extension/planStore.ts",
      line: 42,
    });
    // A column suffix is dropped; the line is what the editor needs.
    expect(parseFileRef("planStore.ts:42:7")).toEqual({
      path: "planStore.ts",
      line: 42,
    });
    expect(parseFileRef("src/a.ts#L9")).toEqual({ path: "src/a.ts", line: 9 });
    // Bare filenames and dotfiles — plans use both as shorthand.
    expect(parseFileRef("package.json")).toEqual({ path: "package.json" });
    expect(parseFileRef(".vscodeignore")).toEqual({ path: ".vscodeignore" });
    // `./` is noise, not part of the path.
    expect(parseFileRef("./build.ts")).toEqual({ path: "build.ts" });
  });

  test("rejects spans that are not a file we could open", () => {
    for (const span of [
      "",
      "bun run build", // a command
      "vscode", // a bare identifier
      "parseComments", // a function
      ".waypoint/plans/*.md", // a glob names a set, not a file
      "media/", // a directory
      "/etc/passwd", // absolute
      "../../secrets.txt", // traversal
      "src/a.ts:0", // lines are 1-based
      "a b/c.ts", // whitespace
      "$HOME/.zshrc", // shell expansion
    ]) {
      expect(parseFileRef(span)).toBeNull();
    }
  });

  test("shape is not existence — a version-like span is still a candidate", () => {
    // Resolution (not the parser) is what keeps this from becoming a link.
    expect(parseFileRef("v1.2")).toEqual({ path: "v1.2" });
  });
});

describe("resolveInsideRoot", () => {
  test("keeps refs inside the workspace", () => {
    const root = "/repo";
    expect(resolveInsideRoot(root, "src/a.ts")).toBe("/repo/src/a.ts");
    expect(resolveInsideRoot(root, "a/../b.ts")).toBe("/repo/b.ts");
    expect(resolveInsideRoot(root, "../outside.ts")).toBeNull();
    expect(resolveInsideRoot(root, "a/../../outside.ts")).toBeNull();
    expect(resolveInsideRoot(root, "/etc/passwd")).toBeNull();
    expect(resolveInsideRoot(root, "")).toBeNull();
  });
});

describe("resolveDirect", () => {
  test("resolves a file, but not a directory or a miss", async () => {
    const root = await mkdtemp(join(tmpdir(), "wp-refs-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    expect(await resolveDirect(root, "src/a.ts")).toBe(join(root, "src", "a.ts"));
    expect(await resolveDirect(root, "src")).toBeNull();
    expect(await resolveDirect(root, "src/missing.ts")).toBeNull();
    expect(await resolveDirect(root, "../escape.ts")).toBeNull();
  });
});

describe("ref helpers", () => {
  test("bare names are the ones worth a basename search", () => {
    expect(isBareName("planStore.ts")).toBe(true);
    expect(isBareName("src/planStore.ts")).toBe(false);
  });

  test("refKey is stable, short, and content-free", () => {
    expect(refKey("src/a.ts")).toBe(refKey("src/a.ts"));
    expect(refKey("src/a.ts")).not.toBe(refKey("src/b.ts"));
    expect(refKey("src/a.ts")).toMatch(/^[0-9a-f]{8}$/);
  });
});
