import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./setup-dom";

// markdown.ts must be imported after the DOM globals exist — DOMPurify
// captures `window` at import time.
const { renderMarkdown } = await import("../src/webview/lib/markdown");

const FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "plans",
  "diagram-test-plan.md",
);

describe("diagram sizing fixture", () => {
  test("renders with at least six mermaid figures", () => {
    const md = readFileSync(FIXTURE, "utf8");
    const el = document.createElement("div");
    el.innerHTML = renderMarkdown(md);
    const figs = el.querySelectorAll("figure.wp-mermaid");
    expect(figs.length).toBeGreaterThanOrEqual(6);
    // Each figure must keep its source — sizeDiagram and the fit rule are
    // useless if the fixture silently loses a diagram to a fence typo.
    for (const fig of figs) {
      const src = fig.querySelector(".wp-mermaid-src")?.textContent ?? "";
      expect(src.trim().length).toBeGreaterThan(0);
      expect(fig.querySelector(".wp-mermaid-out")).not.toBeNull();
    }
  });
});
