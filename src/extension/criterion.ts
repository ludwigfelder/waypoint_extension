import { createHash } from "node:crypto";

/**
 * Content-free stable key for a checklist criterion: first 8 hex chars of the
 * SHA-256 of its raw text. Criteria have no ID of their own in the plan file
 * (they are addressed by ordinal + text); the offline combiner re-hashes plan
 * text to join these keys back to full criteria.
 */
export function criterionKey(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}

/** A human-validation criterion: `@human …`, optionally after a `#ID` prefix. */
export function isHumanCriterion(text: string): boolean {
  return /^(?:#\S+\s+)?@human\b/i.test(text.trim());
}
