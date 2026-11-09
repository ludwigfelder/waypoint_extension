import { describe, expect, test } from "bun:test";
import { htmldiff } from "../src/webview/lib/htmldiff";

/** Tag stream of an HTML string, in order — the structural fingerprint. */
function tags(html: string): string[] {
  return (html.match(/<[^>]+>/g) ?? []).filter(
    (t) => !/^<\/?(ins|del)\b/.test(t),
  );
}

/**
 * The invariant the merge must never break: every tag it emits is matched. A
 * `<li>` open with no close is what corrupted the document before the tag keys
 * were normalized, and it is what the balanced-tag filter exists to prevent.
 */
function wellFormed(html: string): boolean {
  const stack: string[] = [];
  for (const tag of html.match(/<[^>]+>/g) ?? []) {
    const name = /^<\/?([a-zA-Z][\w-]*)/.exec(tag)?.[1].toLowerCase();
    if (!name || tag.endsWith("/>")) continue;
    if (tag[1] === "/") {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

describe("htmldiff", () => {
  test("redlines a changed word in place", () => {
    const out = htmldiff("<p>The quick fox</p>", "<p>The slow fox</p>");
    // A word token carries its own trailing space, so the marked run does too.
    expect(out).toContain('<del class="wp-del" contenteditable="false">quick </del>');
    expect(out).toContain('<ins class="wp-ins">slow </ins>');
    expect(out).toContain("fox");
    // What matters either way: dropping the deleted run leaves the new
    // document byte for byte, spacing included.
    expect(out.replace(/<del class="wp-del"[^>]*>.*?<\/del>/gs, "").replace(/<\/?ins[^>]*>/g, ""))
      .toBe("<p>The slow fox</p>");
  });

  test("an attribute-only change does not duplicate the tag", () => {
    // A checkbox tick and an inline edit both change attributes and nothing
    // else. Keyed on the full tag text these read as replacements, and the
    // merged HTML used to carry two <li> opens against one close.
    const before = '<ul><li class="wp-check" data-blk="0:9">ship it</li></ul>';
    const after =
      '<ul><li class="wp-check is-checked" data-blk="0:11">ship it</li></ul>';
    const out = htmldiff(before, after);
    expect(tags(out)).toEqual(tags(after));
    expect(out).not.toContain("wp-del");
    expect(out).not.toContain("wp-ins");
  });

  test("a restructured document still merges to well-formed HTML", () => {
    const before =
      "<h2>Phase 1</h2><p>First para.</p><ul><li>one</li><li>two</li></ul>";
    const after = "<h2>Phase 1</h2><ul><li>one</li></ul><p>Trailing note.</p>";
    const out = htmldiff(before, after);
    expect(wellFormed(out)).toBe(true);
    expect(out).toContain("Trailing note.");
  });

  test("a wholly deleted block keeps its own wrapper", () => {
    const out = htmldiff("<p>gone entirely</p><p>kept</p>", "<p>kept</p>");
    // The deleted paragraph opened and closed inside the deleted run, so it
    // stays a paragraph rather than spilling into its neighbour.
    expect(wellFormed(out)).toBe(true);
    expect(out).toContain(
      '<p><del class="wp-del" contenteditable="false">gone entirely</del></p>',
    );
    expect(out).toContain("kept");
  });

  test("a partly deleted element contributes words, not a stray tag", () => {
    // The old `<strong>` opens inside the deleted run but closes outside it,
    // so writing it through would leave it unmatched.
    const before = "<p>keep <strong>bold gone</strong> tail</p>";
    const after = "<p>keep <strong>bold</strong> tail</p>";
    const out = htmldiff(before, after);
    expect(wellFormed(out)).toBe(true);
    expect(out).toContain("gone");
  });

  test("identical input is returned unchanged", () => {
    const html = '<p data-blk="0:5">same</p>';
    expect(htmldiff(html, html)).toBe(html);
  });

  test("insertions carry no contenteditable opt-out", () => {
    const out = htmldiff("<p>a</p>", "<p>a b</p>");
    expect(out).toContain('<ins class="wp-ins">');
    expect(out).not.toContain('<ins class="wp-ins" contenteditable');
  });
});

describe("trailing content", () => {
  test("text appended after the last match still shows as an insertion", () => {
    const out = htmldiff("<p>one</p>", "<p>one</p><p>two</p>");
    expect(out).toContain("two");
    expect(wellFormed(out)).toBe(true);
  });

  test("text removed from the end still shows as a deletion", () => {
    const out = htmldiff("<p>one</p><p>two</p>", "<p>one</p>");
    expect(out).toContain('<del class="wp-del" contenteditable="false">two</del>');
    expect(wellFormed(out)).toBe(true);
  });

  test("a criterion appended to the last checklist survives the merge", () => {
    const before = '<ul class="wp-check-list"><li>C1 tests pass</li></ul>';
    const after =
      '<ul class="wp-check-list"><li>C1 tests pass</li><li>C2 build clean</li></ul>';
    const out = htmldiff(before, after);
    expect(out).toContain("C2");
    expect(out).toContain("build clean");
    expect(wellFormed(out)).toBe(true);
  });
});

describe("source ranges in a redlined document", () => {
  test("a deleted wrapper does not carry the baseline's data-blk", () => {
    const before = '<p data-blk="0:12">gone entirely</p><p data-blk="14:18">kept</p>';
    const after = '<p data-blk="0:4">kept</p>';
    const out = htmldiff(before, after);
    // The surviving paragraph keeps the live range; the deleted one keeps none,
    // so a double-click can never resolve a stale offset against the file.
    expect(out).toContain('data-blk="0:4"');
    expect(out).not.toContain('data-blk="0:12"');
    expect(out).not.toContain('data-blk="14:18"');
    expect(wellFormed(out)).toBe(true);
  });
});
