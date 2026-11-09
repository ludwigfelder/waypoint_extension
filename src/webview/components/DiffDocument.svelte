<script lang="ts">
  import hljs from "highlight.js";
  import DOMPurify from "dompurify";
  import { renderMarkdown } from "../lib/markdown";
  import { htmldiff } from "../lib/htmldiff";
  import { loadCardWidth } from "../lib/layout";
  import { readingAnchor, restoreReading, type ReadingAnchor } from "../lib/reading";

  let {
    markdown = "",
    previousMarkdown = "",
    loading = false,
    theme = "light",
  }: {
    markdown: string;
    previousMarkdown: string;
    loading: boolean;
    theme?: "light" | "dark";
  } = $props();

  // Same card geometry as PlanDocument (read from the shared store) so the
  // card doesn't shift when toggling diff on/off; no resize handles here.
  const artW = loadCardWidth();

  // Redline of the previous version → the selected version, computed over the
  // *rendered* HTML of each side so structure (headings, callouts, code) stays
  // intact and the redlines land on the changed words.
  const html = $derived(
    markdown
      ? DOMPurify.sanitize(
          htmldiff(renderMarkdown(previousMarkdown), renderMarkdown(markdown)),
          { ADD_ATTR: ["open", "data-keep", "data-outline", "data-id", "data-ref", "data-rev"] },
        )
      : "",
  );

  let mainEl = $state<HTMLElement>();
  let docEl = $state<HTMLElement>();

  // Outline rail (identical behaviour to PlanDocument).
  // Parked alongside the plan view's rail — see PlanDocument's OUTLINE_RAIL.
  const OUTLINE_RAIL = false;
  let headings = $state<{ id: string; label: string }[]>([]);
  let activeSection = $state<string>("");
  let navHover = $state(false);

  // Syntax-highlight code fences after each render.
  $effect(() => {
    void html;
    if (!docEl) return;
    for (const block of docEl.querySelectorAll("pre code")) {
      try {
        hljs.highlightElement(block as HTMLElement);
      } catch {}
    }
  });

  /* ---------------- outline ---------------- */
  $effect(() => {
    void html;
    if (!docEl) return;
    queueMicrotask(() => buildOutline());
  });

  function buildOutline() {
    if (!docEl) return;
    const hs = [
      ...docEl.querySelectorAll("h1, h2, summary[data-outline]"),
    ] as HTMLElement[];
    headings = hs.map((h, i) => {
      if (!h.id) h.id = "wp-diff-sec-" + i;
      const label =
        h.getAttribute("data-outline") ||
        (i === 0 ? "Overview" : h.textContent || "Section");
      return { id: h.id, label };
    });
    updateActiveSection();
  }

  function updateActiveSection() {
    if (!mainEl || !headings.length) return;
    const mt = mainEl.getBoundingClientRect().top;
    let active = headings[0].id;
    for (const { id } of headings) {
      const el = docEl?.querySelector("#" + CSS.escape(id)) as HTMLElement | null;
      if (!el) continue;
      if (el.getBoundingClientRect().top - mt <= 130) active = id;
      else break;
    }
    if (active !== activeSection) activeSection = active;
  }

  function scrollToSection(id: string) {
    if (!mainEl || !docEl) return;
    const el = docEl.querySelector("#" + CSS.escape(id)) as HTMLElement | null;
    if (!el) return;
    const mt = mainEl.getBoundingClientRect().top;
    const top = Math.max(0, el.getBoundingClientRect().top - mt + mainEl.scrollTop - 28);
    mainEl.scrollTo({ top, behavior: "smooth" });
  }
  /** Reading position, for carrying the reader across a plan/redline swap. */
  export const anchor = (): ReadingAnchor | null => readingAnchor(mainEl, docEl);
  export const restore = (a: ReadingAnchor | null) => restoreReading(a, mainEl, docEl);
</script>

<main
  class="relative flex-1 overflow-auto bg-surface-page outline-none focus:outline-none focus-visible:outline-none"
  bind:this={mainEl}
  onscroll={updateActiveSection}
>
  {#if loading}
    <p class="px-6 py-11 text-sm text-muted">Loading…</p>
  {:else if html}
    <div class="relative ml-4 max-w-[calc(100%-32px)] pb-[60vh] pt-10" style="width:{artW}px;">
      <div class="wp-prose wp-doc-card max-w-full" bind:this={docEl} data-plan-theme={theme}>
        {@html html}
      </div>
    </div>
  {:else}
    <p class="px-6 py-11 text-sm text-muted">Nothing to compare.</p>
  {/if}
</main>

<!-- Outline rail -->
{#if OUTLINE_RAIL && headings.length > 1}
  <nav
    class="ease-standard fixed right-4 top-1/2 z-30 flex -translate-y-1/2 flex-col items-end gap-[7px] rounded-md px-2.5 py-2 transition-[background,box-shadow] duration-[120ms] hover:bg-surface-card hover:shadow-[var(--ring-hairline),var(--shadow-pop)]"
    onmouseenter={() => (navHover = true)}
    onmouseleave={() => (navHover = false)}
    aria-label="Plan outline"
  >
    {#each headings as h (h.id)}
      {@const a = activeSection === h.id}
      <button
        type="button"
        class="inline-flex h-[18px] cursor-pointer items-center justify-end gap-[11px] border-0 bg-transparent p-0"
        onclick={() => scrollToSection(h.id)}
      >
        {#if navHover}
          <span
            class="whitespace-nowrap font-sans text-[9px] font-medium uppercase tracking-[0.08em] {a
              ? 'font-bold text-wp-green-700'
              : 'text-subtle'}"
          >
            {h.label}
          </span>
        {/if}
        <span
          class="h-[7px] w-[7px] shrink-0 rounded-full {a
            ? 'bg-wp-green-700'
            : 'bg-wp-gray-300'}"
        ></span>
      </button>
    {/each}
  </nav>
{/if}
