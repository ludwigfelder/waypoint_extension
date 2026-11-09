<script lang="ts">
  import Icon from "./Icon.svelte";
  let { message = "" }: { message: string } = $props();
</script>

{#if message}
  <div
    class="animate-wp-toast fixed bottom-7 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-2 rounded-sm bg-wp-ink-800 px-3.5 py-[9px] font-display text-[13px] text-on-fill shadow-pop"
  >
    <Icon name="check" size={16} class="text-wp-green-500" />
    <span>{message}</span>
  </div>
{/if}
