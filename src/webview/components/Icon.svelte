<script lang="ts">
  // A handful of inline icons (majesticons-style) so we don't depend on the
  // external iconify web component, which the webview CSP blocks.
  let {
    name,
    size = 16,
    class: cls = "",
  }: {
    name:
      | "moon"
      | "sun"
      | "check"
      | "comment"
      | "chevron-down"
      | "chevron-right"
      | "plus"
      | "diff"
      | "spinner"
      | "search";
    size?: number;
    class?: string;
  } = $props();

  const paths: Record<string, string> = {
    moon: "M14.5 11.5A6 6 0 0 1 7 4a.6.6 0 0 0-.82-.7A7 7 0 1 0 15.2 12.3a.6.6 0 0 0-.7-.8Z",
    sun: "M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM10 2v1.5M10 16.5V18M4.2 4.2l1 1M14.8 14.8l1 1M2 10h1.5M16.5 10H18M4.2 15.8l1-1M14.8 5.2l1-1",
    check: "M4 10.5l3.5 3.5L16 5.5",
    comment:
      "M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v6A1.5 1.5 0 0 1 15.5 13H8l-3.5 3v-3H4.5A1.5 1.5 0 0 1 3 11.5v-6Z",
    "chevron-down": "M5 7.5L10 12.5L15 7.5",
    "chevron-right": "M7.5 5L12.5 10L7.5 15",
    plus: "M10 4.5v11M4.5 10h11",
    // Redline/compare glyph: an added (+) line over a removed (−) line.
    diff: "M4 7h3M5.5 5.5v3M9.5 7h6.5M4 13h3M9.5 13h6.5",
    // Work in progress: a three-quarter arc with an arrowhead, spun by
    // `animate-wp-spin`. The gap is what reads as motion once it turns.
    spinner: "M16 10a6 6 0 1 1-1.76-4.24M16 4.5v3.2h-3.2",
    // Review: a magnifying glass.
    search: "M8.5 3.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM12.2 12.2 16.5 16.5",
  };
</script>

<svg
  class={cls}
  width={size}
  height={size}
  viewBox="0 0 20 20"
  fill="none"
  stroke="currentColor"
  stroke-width="1.6"
  stroke-linecap="round"
  stroke-linejoin="round"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
>
  <path d={paths[name]} />
</svg>
