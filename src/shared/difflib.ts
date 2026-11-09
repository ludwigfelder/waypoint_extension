// difflib-style sequence matching over arbitrary token keys, ported from
// Python's SequenceMatcher. Shared so the webview's word-level HTML redline and
// the host's line-level plan diff describe the same change the same way.
//
// Self-contained (no npm dep) so it stays CSP-safe inside the webview bundle.

export type Op = [
  op: "equal" | "delete" | "insert" | "replace",
  i1: number,
  i2: number,
  j1: number,
  j2: number,
];

type Block = [ai: number, bj: number, size: number];

/** difflib SequenceMatcher.find_longest_match, restricted to [alo,ahi)/[blo,bhi). */
function findLongestMatch(
  a: string[],
  b2j: Map<string, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): Block {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    const positions = b2j.get(a[i]);
    if (positions) {
      for (const j of positions) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }
  return [besti, bestj, bestsize];
}

/**
 * difflib SequenceMatcher.get_matching_blocks.
 *
 * Cost note: `findLongestMatch` walks every recorded position of `a[i]` for
 * each i, so a key occurring thousands of times makes the scan quadratic.
 * difflib answers that with junk heuristics; callers here answer it by choosing
 * tokens that are not ultra-popular in the first place (see htmldiff's
 * tokenizer). Both junk variants were tried and both degrade the redline —
 * autojunk turned 440 change spans into 9074, and junking whitespace pushed
 * spaces inside the marked runs, doubling them in the rendered text.
 */
function matchingBlocks(a: string[], b: string[]): Block[] {
  const b2j = new Map<string, number[]>();
  b.forEach((k, j) => {
    const arr = b2j.get(k);
    if (arr) arr.push(j);
    else b2j.set(k, [j]);
  });

  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  const blocks: Block[] = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongestMatch(a, b2j, alo, ahi, blo, bhi);
    if (k > 0) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  // difflib's terminating sentinel. Without it `opcodes` never emits the tail
  // after the last match, so anything appended to the end of a plan — a new
  // final paragraph, a criterion added to the last checklist — vanishes from
  // the output entirely instead of showing as an insertion.
  blocks.push([a.length, b.length, 0]);
  return blocks;
}

/** difflib SequenceMatcher.get_opcodes. */
export function opcodes(a: string[], b: string[]): Op[] {
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  for (const [ai, bj, size] of matchingBlocks(a, b)) {
    if (i < ai && j < bj) ops.push(["replace", i, ai, j, bj]);
    else if (i < ai) ops.push(["delete", i, ai, j, bj]);
    else if (j < bj) ops.push(["insert", i, ai, j, bj]);
    if (size) ops.push(["equal", ai, ai + size, bj, bj + size]);
    i = ai + size;
    j = bj + size;
  }
  return ops;
}
