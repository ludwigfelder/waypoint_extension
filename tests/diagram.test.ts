import { describe, expect, test } from "bun:test";

const { fitDiagram, diagramMermaidConfig, MIN_SCALE, DIAGRAM_FONT_PX } =
  await import("../src/webview/lib/diagram");

describe("fitDiagram", () => {
  test("a diagram narrower than the column renders at its natural size", () => {
    expect(fitDiagram(400, 680)).toEqual({ width: 400, scroll: false });
  });

  test("an exact fit renders untouched", () => {
    expect(fitDiagram(680, 680)).toEqual({ width: 680, scroll: false });
  });

  test("overflow that stays at or above the floor fits the column", () => {
    // 700 -> 680 is a 0.971 scale, comfortably above the floor.
    expect(fitDiagram(700, 680)).toEqual({ width: 680, scroll: false });
    // Exactly at the floor still fits — MIN_SCALE is allowed, not excluded.
    expect(fitDiagram(680 / MIN_SCALE, 680)).toEqual({
      width: 680,
      scroll: false,
    });
  });

  test("overflow past the floor holds the floor width and scrolls", () => {
    expect(fitDiagram(1360, 680)).toEqual({
      width: Math.round(1360 * MIN_SCALE),
      scroll: true,
    });
    expect(fitDiagram(1360, 680).width).toBe(1156);
  });

  test("degenerate inputs fall back to the column width without scrolling", () => {
    for (const [natural, col] of [
      [0, 680],
      [NaN, 680],
      [-100, 680],
    ] as const) {
      expect(fitDiagram(natural, col)).toEqual({ width: 680, scroll: false });
    }
    expect(fitDiagram(900, 0)).toEqual({ width: 0, scroll: false });
    expect(fitDiagram(900, NaN)).toEqual({ width: NaN, scroll: false });
  });
});

describe("diagramMermaidConfig", () => {
  test("carries the font settings on both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const cfg = diagramMermaidConfig(theme, "Inter, sans-serif");
      expect(cfg.themeVariables).toEqual({
        fontFamily: "Inter, sans-serif",
        fontSize: `${DIAGRAM_FONT_PX}px`,
      });
      expect(cfg.securityLevel).toBe("strict");
      expect(cfg.startOnLoad).toBe(false);
    }
  });

  test("maps the viewer theme onto mermaid's", () => {
    expect(diagramMermaidConfig("dark", "x").theme).toBe("dark");
    expect(diagramMermaidConfig("light", "x").theme).toBe("default");
  });
});

describe("sizing constants", () => {
  test("the floor keeps diagram type above the 14px body text", () => {
    expect(MIN_SCALE).toBe(0.85);
    expect(DIAGRAM_FONT_PX * MIN_SCALE).toBeGreaterThan(14);
  });
});
