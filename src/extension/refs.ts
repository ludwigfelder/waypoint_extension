import { isAbsolute, join, relative, sep } from "node:path";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";

/**
 * Resolving a plan's file references against the workspace.
 *
 * The viewer sends candidate paths (shape-matched by shared/refs.ts) and gets
 * back the ones that name a real file, so only those render as links. Two
 * lookups, in order:
 *
 *   1. workspace-relative — `src/extension/planStore.ts`
 *   2. unique basename    — `planStore.ts`, which plans use as shorthand
 *
 * The basename search is the caller's job (it needs VS Code's file index);
 * this module owns the path safety and the direct hit, both of which are pure
 * enough to test without a running extension host.
 */

/**
 * `root`-relative `path` as an absolute path, or null when it would escape the
 * workspace. A ref is a pointer into *this* repo — an absolute path or a `..`
 * climb is either a mistake or an attempt to make the viewer open something
 * outside it, and both are refused rather than clamped.
 */
export function resolveInsideRoot(root: string, path: string): string | null {
  if (!path || isAbsolute(path)) return null;
  const full = join(root, path);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || rel.startsWith(`..${sep}`)) return null;
  if (isAbsolute(rel)) return null;
  return full;
}

/** True when `fsPath` names an existing regular file. */
export async function isFile(fsPath: string): Promise<boolean> {
  try {
    return (await stat(fsPath)).isFile();
  } catch {
    return false;
  }
}

/**
 * The direct workspace-relative hit for `path`, or null. Callers fall back to
 * a basename search only for the paths this returns null for.
 */
export async function resolveDirect(
  root: string,
  path: string,
): Promise<string | null> {
  const full = resolveInsideRoot(root, path);
  return full && (await isFile(full)) ? full : null;
}

/** A bare `planStore.ts`-style ref: worth a basename search, a path is not. */
export const isBareName = (path: string): boolean => !path.includes("/");

/**
 * Content-free stable key for a referenced path — first 8 hex of its SHA-256,
 * the same shape criteria use, so the interaction log records *that* a
 * reviewer followed a reference without recording the repo's file names.
 */
export function refKey(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex").slice(0, 8);
}
