<script lang="ts">
  import Icon from "./Icon.svelte";
  import Button from "./Button.svelte";
  import { parsePhases, activePhaseIndex, prefixDone } from "../lib/phases";
  import { computeDrift } from "../lib/drift";

  let {
    markdown = "",
    accepted = false,
    acceptedUpTo = null,
    onReflect,
    onDriftShown,
    onJumpToPhase,
  }: {
    markdown: string;
    accepted: boolean;
    acceptedUpTo?: number | null;
    onReflect?: () => void;
    onJumpToPhase?: (title: string) => void;
    onDriftShown?: (d: {
      deviationCount: number;
      assertedCount: number;
      danglingProbeCount: number;
      duplicateIdCount: number;
    }) => void;
  } = $props();

  const phases = $derived(parsePhases(markdown));
  const active = $derived(activePhaseIndex(phases));
  const allDone = $derived(phases.length > 0 && active === -1);
  const totalChecked = $derived(phases.reduce((n, p) => n + p.checked, 0));
  const totalCriteria = $derived(phases.reduce((n, p) => n + p.total, 0));
  // Always visible when the plan has phases: the pills are the document's only
  // section-jump affordance (the outline rail is off), so withholding them
  // until implementation starts leaves a long plan with no navigation (#D6).
  const show = $derived(phases.length > 0);
  // Nothing accepted and nothing ticked — the rail is a table of contents, and
  // must claim no progress it cannot see.
  const reviewing = $derived(!accepted && totalChecked === 0);
  // Partial implement finished: the accepted prefix is green but later phases
  // remain — offer Reflect (/waypoint-update) to reconcile them.
  const partialDone = $derived(
    acceptedUpTo != null && !allDone && prefixDone(phases, acceptedUpTo),
  );

  // Post-run drift frame (ADJ-21): completion is what the agent claims; drift
  // is what the reviewer needs. Derived from the file, so it survives reload;
  // legacy plans (no evidence, no run record) keep the plain banner.
  const drift = $derived(computeDrift(markdown));
  const driftWarn = $derived(
    drift.ticks.asserted > 0 ||
      drift.danglingProbes.length > 0 ||
      drift.duplicateIds.length > 0,
  );
  const driftLine = $derived.by(() => {
    const parts: string[] = [];
    const dev = drift.deviations;
    parts.push(
      dev.length
        ? `${dev.length} deviation${dev.length === 1 ? "" : "s"} (${[...new Set(dev.map((d) => d.id))].join(", ")})`
        : "no deviations recorded",
    );
    parts.push(
      drift.ticks.asserted
        ? `${drift.ticks.asserted} asserted tick${drift.ticks.asserted === 1 ? "" : "s"}`
        : "all agent ticks evidence-backed",
    );
    if (drift.danglingProbes.length)
      parts.push(`dangling probe ${drift.danglingProbes.join(", ")}`);
    if (drift.duplicateIds.length)
      parts.push(`duplicate ID ${drift.duplicateIds.join(", ")}`);
    return parts.join(" · ");
  });

  $effect(() => {
    if (show && allDone && drift.postRun)
      onDriftShown?.({
        deviationCount: drift.deviations.length,
        assertedCount: drift.ticks.asserted,
        danglingProbeCount: drift.danglingProbes.length,
        duplicateIdCount: drift.duplicateIds.length,
      });
  });

  // Left padding is set per pill: a marker sits closer to the edge than bare
  // text does, and Tailwind will not arbitrate two `pl-*` on one element.
  const stepBase =
    "inline-flex items-center gap-1.5 rounded-pill bg-surface-card py-1 pr-2.5 font-sans text-[11px] font-medium shadow-hairline";
  const markerBase =
    "inline-flex h-[17px] w-[17px] items-center justify-center rounded-full text-[10px] font-bold";
</script>

{#if show}
  <div
    class="animate-wp-fade shrink-0 px-[22px] py-2.5 shadow-[inset_0_-1px_0_var(--border-hairline)] {reviewing
      ? 'bg-surface-page'
      : 'bg-wp-green-100'}"
  >
    <!-- One row: the status line (none while reviewing — the pills speak for
         themselves) and the phase pills share it, wrapping only when the
         panel is too narrow for both. -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      {#if !reviewing}
        <div class="flex items-center gap-2 font-display text-[13px] text-wp-green-800">
        {#if allDone && drift.postRun}
          <Icon name="check" size={15} />
          <span>
            Run finished — <span class={driftWarn ? "text-wp-orange-500" : ""}>{driftLine}</span>
          </span>
        {:else if allDone}
          <Icon name="check" size={15} />
          <span>Implementation complete — all acceptance criteria met.</span>
        {:else if partialDone}
          <Icon name="check" size={15} />
          <span>
            {acceptedUpTo === 1 ? "Phase 1" : `Phases 1–${acceptedUpTo}`} implemented
            — remaining phases may need updating.
          </span>
          {#if onReflect}
            <span class="ml-1">
              <Button variant="outline" size="sm" onclick={onReflect}>Reflect</Button>
            </span>
          {/if}
        {:else}
          <span
            class="animate-wp-spin h-3 w-3 rounded-full border-2 border-wp-green-800 border-t-transparent"
            aria-hidden="true"
          ></span>
          <span>Implementing — {totalChecked}/{totalCriteria} criteria met</span>
        {/if}
      </div>
      {/if}
      <ol class="m-0 flex list-none flex-wrap items-center gap-[7px] p-0">
        {#each phases as p, i (p.title)}
          {@const isActive = i === active}
          {@const running = isActive && !reviewing}
          <li>
            <button
              type="button"
              class="{stepBase} cursor-pointer border-0 hover:bg-wp-gray-100 {running
                ? 'text-wp-orange-500 shadow-[inset_0_0_0_1.5px_var(--color-orange-500)]'
                : p.done
                  ? 'text-body'
                  : 'text-muted'} {p.done || running ? 'pl-1.5' : 'pl-2.5'}"
              title="Jump to {p.title}"
              onclick={() => onJumpToPhase?.(p.title)}
            >
              <!-- A marker only where it says something the label does not. The
                   label already reads "Phase 3", so a numbered disc beside it is
                   the same fact twice; done and in-progress are not in the label. -->
              {#if p.done}
                <span class="{markerBase} bg-wp-green-700 text-on-fill">
                  <Icon name="check" size={12} />
                </span>
              {:else if running}
                <!-- Same disc as the done marker, in orange: the two states read
                     as one family, distinguished by colour and glyph. Static —
                     the rail redraws on each tick, so motion would be noise. -->
                <span class="{markerBase} bg-wp-orange-500 text-on-fill">
                  <Icon name="spinner" size={12} />
                </span>
              {/if}
              <span>{p.label}</span>
              {#if running && p.total}
                <span class="text-subtle tabular-nums">{p.checked}/{p.total}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ol>
    </div>
  </div>
{/if}
