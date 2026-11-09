<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    variant = "primary",
    size = "sm",
    disabled = false,
    title = "",
    class: cls = "",
    onclick,
    children,
  }: {
    variant?: "primary" | "secondary" | "outline" | "ghost" | "attention";
    size?: "sm" | "md";
    disabled?: boolean;
    title?: string;
    class?: string;
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
  } = $props();

  const base =
    "wp-btn inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border-0 font-display font-semibold transition-[background,box-shadow,opacity] duration-[120ms] ease-standard disabled:cursor-default disabled:opacity-40";
  const variants = {
    primary: "bg-wp-green-700 text-on-fill enabled:hover:bg-wp-green-800",
    secondary: "bg-wp-indigo-600 text-on-fill enabled:hover:bg-wp-indigo-800",
    outline: "bg-transparent text-body shadow-hairline enabled:hover:bg-wp-gray-100",
    // Something is waiting on the reader — the same orange the "In review"
    // badge and the setup banner use, filled so it reads across the header.
    attention: "bg-wp-orange-500 text-on-fill enabled:hover:bg-wp-orange-700",
    ghost: "bg-transparent text-muted enabled:hover:bg-wp-gray-100 enabled:hover:text-strong",
  };
  const sizes = {
    sm: "px-3 py-1.5 text-xs",
    md: "px-3.5 py-2 text-[13px]",
  };
</script>

<button
  type="button"
  class="{base} {variants[variant]} {sizes[size]} {cls}"
  {disabled}
  {title}
  onclick={onclick}
>
  {@render children()}
</button>
