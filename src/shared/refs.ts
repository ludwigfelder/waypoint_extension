/**
 * File references inside plan prose.
 *
 * Plans name real files constantly — `src/extension/planStore.ts:42`,
 * `.vscodeignore`, `out/extension.js` — and a reviewer's first instinct is to
 * go look. This module decides which inline code spans *look* like a file in
 * the repo; the extension host decides which ones actually are (it stats them)
 * so the viewer never shows a link that leads nowhere.
 *
 * Deliberately permissive: a false candidate costs one failed stat and simply
 * renders as ordinary code, while a missed one costs the reviewer a trip
 * through the file tree.
 */

export type FileRef = {
  /** Workspace-relative path, `./` stripped. Never absolute, never escaping. */
  path: string;
  /** 1-based line from a `:42`, `:42:7`, or `#L42` suffix. */
  line?: number;
};

/** `path:42`, `path:42:7`, `path#L42` — the line suffix, if any. */
const LINE_SUFFIX = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+))$/;
/** Path characters a plan would use. No spaces, globs, or shell punctuation. */
const PATH_CHARS = /^[A-Za-z0-9._@+\-/]+$/;
/** `planStore.ts`, `package.json`, `reload.sh` — a name with an extension. */
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;
/** `.vscodeignore`, `.gitignore` — a dotfile with no further dot. */
const DOTFILE = /^\.[A-Za-z0-9_-]+$/;

/**
 * The file reference an inline code span names, or null when it names
 * something else (prose, an identifier, a command, a glob).
 */
export function parseFileRef(text: string): FileRef | null {
  const raw = text.trim();
  // Anything with whitespace is a command or a sentence; anything with a glob
  // or shell metacharacter names a set, not a file we could open.
  if (!raw || /\s/.test(raw)) return null;

  const m = LINE_SUFFIX.exec(raw);
  const lineText = m?.[2] ?? m?.[3];
  let path = m ? m[1] : raw;
  const line = lineText ? Number(lineText) : undefined;
  if (line != null && (!Number.isInteger(line) || line < 1)) return null;

  if (path.startsWith("./")) path = path.slice(2);
  if (!PATH_CHARS.test(path)) return null;
  // Absolute paths and traversal are out: refs address this workspace only.
  if (path.startsWith("/") || path.split("/").includes("..")) return null;
  if (path.endsWith("/")) return null; // a directory, nothing to open

  const base = path.slice(path.lastIndexOf("/") + 1);
  if (!base || base === "." || base === "..") return null;
  // A path-shaped span is a candidate on its own; a bare name has to look like
  // a filename, or every identifier in the plan would become a candidate.
  if (!path.includes("/") && !HAS_EXTENSION.test(base) && !DOTFILE.test(base))
    return null;

  return line == null ? { path } : { path, line };
}

/** The key a resolved-ref lookup is cached under (path only — lines are free). */
export const refKeyOf = (ref: FileRef): string => ref.path;
