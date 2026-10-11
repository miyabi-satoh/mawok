<script lang="ts">
	import type { Snippet } from 'svelte';
	import SettingsModifiedMark from '$lib/components/settings-modified-mark.svelte';

	let { children, modified }: { children?: Snippet; modified?: string } = $props();
</script>

<div
	class="relative flex flex-col gap-2 px-4 py-3 leading-snug"
	data-settings-row
	data-modified={modified}
>
	{#if modified}
		<SettingsModifiedMark />
	{/if}
	{@render children?.()}
</div>
