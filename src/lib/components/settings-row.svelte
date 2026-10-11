<script lang="ts">
	import type { Snippet } from 'svelte';
	import SettingsModifiedMark from '$lib/components/settings-modified-mark.svelte';
	import { m } from '$lib/paraglide/messages';

	let { children, modified = false }: { children?: Snippet; modified?: boolean } = $props();
</script>

<div
	class="relative flex flex-col gap-2 px-4 py-3 leading-snug"
	data-settings-row
	data-modified={modified || undefined}
	title={modified ? m.settings_modified() : undefined}
>
	{#if modified}
		<SettingsModifiedMark />
	{/if}
	{@render children?.()}
</div>
