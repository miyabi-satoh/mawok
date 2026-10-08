<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, children }: { title?: string; children?: Snippet } = $props();
</script>

<section class="flex flex-col gap-2">
	{#if title}
		<h2 class="px-1 text-[13px] font-medium text-muted-foreground">{title}</h2>
	{/if}
	<!-- 行の下に区切り線を引く。カード内の最後の行だけ引かない -->
	<div
		class="overflow-hidden rounded-lg border bg-card [&>[data-settings-row]:not(:last-child)]:border-b"
	>
		{@render children?.()}
	</div>
</section>
