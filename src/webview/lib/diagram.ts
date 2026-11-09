// Diagram sizing. Mermaid fits the container at any cost to legibility; we
// instead hold a minimum scale and let wide diagrams scroll (the treatment
// wide tables already get in .wp-prose table).

/** Never render a diagram below this fraction of its natural size. */
export const MIN_SCALE = 0.85;
/** Mermaid base font. Bigger than the 14px body text on purpose. */
export const DIAGRAM_FONT_PX = 18;

export type DiagramFit = { width: number; scroll: boolean };

/** Mermaid config for the inline renderer. Re-applied on every theme change. */
export function diagramMermaidConfig(
  theme: "light" | "dark",
  fontFamily: string,
) {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    theme: theme === "dark" ? ("dark" as const) : ("default" as const),
    themeVariables: { fontFamily, fontSize: `${DIAGRAM_FONT_PX}px` },
    flowchart: { padding: 10, nodeSpacing: 36, rankSpacing: 44 },
  };
}

export function fitDiagram(naturalW: number, colW: number): DiagramFit {
  if (!(naturalW > 0) || !(colW > 0)) return { width: colW, scroll: false };
  if (naturalW <= colW) return { width: naturalW, scroll: false };
  if (colW / naturalW >= MIN_SCALE) return { width: colW, scroll: false };
  return { width: Math.round(naturalW * MIN_SCALE), scroll: true };
}
