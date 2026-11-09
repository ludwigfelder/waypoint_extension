<script lang="ts">
  import Button from "./Button.svelte";
  import Icon from "./Icon.svelte";
  import { planTitle } from "../lib/format";
  import type { Plan, VersionInfo } from "../lib/api";
  import type { PhaseInfo } from "../lib/phases";

  let {
    plans = [],
    selected = null,
    theme = "light",
    status = "review",
    versions = [],
    version = 1,
    isCurrent = true,
    commentCount = 0,
    pending = false,
    diffView = false,
    canDiff = false,
    regenerating = false,
    onDismissRegenerating,
    phases = [],
    onSelectPlan,
    onSelectVersion,
    onToggleTheme,
    onToggleDiff,
    onSendBack,
    onAccept,
    onReopen,
    onReinstall,
  }: {
    plans: Plan[];
    selected: string | null;
    theme: "light" | "dark";
    status: "review" | "accepted";
    versions: VersionInfo[];
    version: number;
    isCurrent: boolean;
    commentCount: number;
    /** Review work the agent has not seen yet — comments, verdicts, direct edits. */
    pending: boolean;
    diffView: boolean;
    canDiff: boolean;
    /** Waiting on the agent's rewrite after a send-back. */
    regenerating?: boolean;
    /** Give up on the wait by hand — the spinner always has an exit. */
    onDismissRegenerating?: () => void;
    phases?: PhaseInfo[];
    onSelectPlan: (name: string) => void;
    onSelectVersion: (n: number) => void;
    onToggleTheme: () => void;
    onToggleDiff: () => void;
    onSendBack: () => void;
    onAccept: (upTo?: number) => void;
    onReopen: () => void;
    onReinstall: () => void;
  } = $props();

  let menuOpen = $state(false);
  let verMenuOpen = $state(false);
  let acceptMenuOpen = $state(false);
  let repoMenuOpen = $state(false);
  const others = $derived(plans.filter((p) => p.name !== selected));
  const latest = $derived(versions.find((v) => v.current)?.n ?? version);

  function pick(name: string) {
    menuOpen = false;
    onSelectPlan(name);
  }
  function pickVersion(n: number) {
    verMenuOpen = false;
    onSelectVersion(n);
  }

  // Shared dropdown chrome (three menus: plan picker, versions, accept-by-phase).
  const menuCls =
    "animate-wp-scale absolute top-[calc(100%+6px)] z-40 m-0 list-none rounded-sm bg-surface-card p-1 shadow-[var(--ring-hairline),var(--shadow-pop)]";
  const menuItemCls =
    "w-full cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap rounded-xs border-0 bg-transparent px-[9px] py-[7px] text-left font-display text-[13px] text-body hover:bg-wp-gray-100 hover:text-strong";
  const iconBtnCls =
    "inline-flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-body shadow-hairline enabled:hover:bg-wp-gray-100 disabled:cursor-default disabled:opacity-40";
  const badgeCls =
    "inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 font-sans text-[11px] font-semibold";
</script>

<svelte:window onclick={() => { menuOpen = false; verMenuOpen = false; acceptMenuOpen = false; repoMenuOpen = false; }} />

<header
  class="@container/wpheader z-20 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2 bg-surface-page px-3 py-2.5 shadow-[inset_0_-1px_0_var(--border-hairline)]"
>
  <!-- The breadcrumb is the only thing here that may shrink: the plan name
       truncates with an ellipsis (min-w-0 down the chain) while the version
       pill and every control to the right keep their size, so a narrow panel
       clips the name rather than drawing the pill over the buttons. -->
  <div class="flex min-w-0 flex-1 items-center gap-1 font-sans text-xs text-subtle">
    <span class="@max-[560px]/wpheader:hidden inline-flex items-center gap-[5px]">
      <div class="relative" onclick={(e) => e.stopPropagation()}>
        <button
          type="button"
          class="m-0 inline-flex cursor-pointer items-center gap-1 rounded-xs border-0 bg-transparent px-[5px] py-0.5 font-mono text-[10px] text-subtle hover:bg-wp-gray-100 hover:text-body"
          title="Waypoint"
          onclick={() => (repoMenuOpen = !repoMenuOpen)}
        >
          waypoint
          <Icon name="chevron-down" size={12} />
        </button>
        {#if repoMenuOpen}
          <ul class="{menuCls} left-0 min-w-55">
            <li>
              <button
                type="button"
                class={menuItemCls}
                onclick={() => {
                  repoMenuOpen = false;
                  onReinstall();
                }}
              >
                Reinstall Waypoint
              </button>
            </li>
          </ul>
        {/if}
      </div>
      <span>/</span>
    </span>
    {#if selected}
      <div class="relative min-w-0" onclick={(e) => e.stopPropagation()}>
        <button
          type="button"
          class="m-0 inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-xs border-0 bg-transparent px-[5px] py-0.5 text-body disabled:cursor-default enabled:hover:bg-wp-gray-100"
          disabled={others.length === 0}
          onclick={() => (menuOpen = !menuOpen)}
        >
          <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-display text-[11.5px] text-body">
            {planTitle(selected)}
          </span>
          {#if others.length}
            <Icon name="chevron-down" size={14} class="shrink-0" />
          {/if}
        </button>
        {#if menuOpen && others.length}
          <ul class="{menuCls} left-0 min-w-55 max-w-90">
            {#each others as p (p.name)}
              <li>
                <button type="button" class={menuItemCls} onclick={() => pick(p.name)}>
                  {planTitle(p.name)}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {:else}
      <span class="whitespace-nowrap font-display text-[11.5px] text-subtle">No plan</span>
    {/if}

    {#if selected && versions.length > 1}
      <div class="relative shrink-0" onclick={(e) => e.stopPropagation()}>
        <button
          type="button"
          class="inline-flex cursor-pointer items-center gap-1 rounded-pill border-0 bg-transparent px-2 py-[3px] font-mono text-[11px] text-body shadow-hairline hover:bg-wp-gray-100"
          title="Select version"
          data-tip="Select version"
          onclick={() => (verMenuOpen = !verMenuOpen)}
        >
          v{version}{isCurrent ? "" : " · resolved"}
          <Icon name="chevron-down" size={13} />
        </button>
        {#if verMenuOpen}
          <!-- Each resolved row carries its note: why that version was
               superseded. That is the plan's revision history, readable
               without opening a single version. -->
          <ul class="{menuCls} left-0 min-w-[150px] max-w-[360px]">
            {#each versions as v (v.n)}
              <li>
                <button
                  type="button"
                  class="{menuItemCls} flex items-start justify-between gap-2.5 font-mono text-xs {v.n === version
                    ? 'bg-wp-gray-100 text-strong'
                    : ''}"
                  title={v.note ?? ""}
                  onclick={() => pickVersion(v.n)}
                >
                  <span class="shrink-0">v{v.n}</span>
                  <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right font-sans text-[10px] text-subtle">
                    {v.current ? "current" : (v.note ?? "resolved")}
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </div>

  <button
    type="button"
    class="{iconBtnCls} {diffView
      ? 'bg-wp-green-100 text-wp-green-800 shadow-[inset_0_0_0_1px_var(--color-green-700)]'
      : ''}"
    disabled={!canDiff}
    title="Toggle diff mode"
    data-tip="Toggle diff mode"
    data-tip-align="end"
    onclick={onToggleDiff}
  >
    <Icon name="diff" size={17} />
  </button>

  <button
    type="button"
    class={iconBtnCls}
    title="Toggle mode"
    data-tip="Toggle mode"
    data-tip-align="end"
    onclick={onToggleTheme}
  >
    <Icon name={theme === "dark" ? "sun" : "moon"} size={17} />
  </button>

  {#if regenerating}
    <!-- The version label already moved to v{version}, but its text is still
         being written. Say so, rather than letting the old prose pass for new. -->
    <button
      type="button"
      class="{badgeCls} cursor-pointer border-0 bg-wp-indigo-100 text-wp-indigo-800 hover:brightness-95"
      title="Still writing — click to dismiss"
      onclick={onDismissRegenerating}
    >
      <span
        class="h-2.5 w-2.5 shrink-0 animate-wp-spin rounded-full border border-current border-t-transparent"
        aria-hidden="true"
      ></span>
      Writing v{version}…
    </button>
  {:else if isCurrent}
    <!-- The state as a glyph, not a word: a magnifying glass while the plan
         is under review, a check once it is accepted. The word is the tooltip. -->
    <span
      class="inline-flex h-[30px] w-[30px] items-center justify-center rounded-pill {status ===
      'accepted'
        ? 'bg-wp-green-100 text-wp-green-800'
        : 'bg-wp-orange-100 text-wp-orange-500'}"
      role="status"
      aria-label={status === "accepted" ? "Accepted" : "In review"}
      title={status === "accepted" ? "Accepted" : "In review"}
      data-tip={status === "accepted" ? "Accepted" : "In review"}
      data-tip-align="end"
    >
      <Icon name={status === "accepted" ? "check" : "search"} size={16} />
    </span>
  {:else}
    <span class="{badgeCls} bg-wp-indigo-100 text-wp-indigo-800">
      <span class="h-1.5 w-1.5 rounded-full bg-current"></span>
      Resolved
    </span>
  {/if}

  {#if selected}
    <div class="flex items-center gap-2">
      {#if isCurrent}
        <!-- Filled orange the moment there is unsent review work: a comment, a
             callout verdict, an inline edit, or a gate added or removed. The
             agent has not seen any of it until this button is pressed. -->
        <Button
          variant={pending ? "attention" : "outline"}
          size="sm"
          disabled={regenerating}
          title={regenerating
            ? "Waiting for the agent to write the new version"
            : pending
              ? "Unsent review changes — send them to the agent"
              : "Send the plan back to the agent"}
          onclick={onSendBack}
        >
          Send back
        </Button>
        {#if status === "accepted"}
          <Button variant="ghost" size="sm" disabled={regenerating} onclick={onReopen}>Reopen</Button>
        {:else if phases.length >= 2}
          <!-- Split accept: primary = full accept; chevron = accept-by-phase.
               The full accept covers phase N, so the menu stops at N-1. -->
          <div class="relative inline-flex items-stretch" onclick={(e) => e.stopPropagation()}>
            <Button variant="primary" size="sm" disabled={regenerating} class="rounded-r-none text-on-fill" onclick={() => onAccept()}>
              Accept plan
            </Button>
            <button
              type="button"
              class="inline-flex w-6 cursor-pointer items-center justify-center rounded-r-sm border-0 bg-wp-green-700 p-0 text-on-fill shadow-[inset_1px_0_0_rgba(255,255,255,0.25)] hover:bg-wp-green-800 {acceptMenuOpen
                ? 'bg-wp-green-800'
                : ''}"
              aria-label="Accept up to a phase"
              title="Accept up to a phase"
              disabled={regenerating}
              onclick={() => (acceptMenuOpen = !acceptMenuOpen)}
            >
              <Icon name="chevron-down" size={14} />
            </button>
            {#if acceptMenuOpen}
              <ul class="{menuCls} right-0 min-w-60">
                {#each phases.slice(0, -1) as p, i (p.title)}
                  <li>
                    <button
                      type="button"
                      class="flex w-full cursor-pointer flex-col items-start gap-px rounded-xs border-0 bg-transparent px-[9px] py-[7px] text-left font-display text-[13px] text-body hover:bg-wp-gray-100 hover:text-strong"
                      onclick={() => {
                        acceptMenuOpen = false;
                        onAccept(i + 1);
                      }}
                    >
                      <span>Implement up to {p.label}</span>
                      <span class="max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-sans text-[11px] text-subtle">
                        {p.title}
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {:else}
          <Button variant="primary" size="sm" disabled={regenerating} onclick={() => onAccept()}>Accept plan</Button>
        {/if}
      {:else}
        <Button variant="primary" size="sm" onclick={() => onSelectVersion(latest)}>
          Back to current
        </Button>
      {/if}
    </div>
  {/if}
</header>
