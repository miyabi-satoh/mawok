<script lang="ts">
	import CloudIcon from '@lucide/svelte/icons/cloud';
	import CloudOffIcon from '@lucide/svelte/icons/cloud-off';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';

	/**
	 * 一覧の1行を同期するかの印。意味の説明は一覧の上に一度だけ出すので、ここには置かない。
	 * name は読み上げで行を見分けるためのもの。行に名前が無ければ渡さない
	 */
	let {
		pressed,
		name = '',
		onchange
	}: { pressed: boolean; name?: string; onchange: (pressed: boolean) => void } = $props();
</script>

<Button
	variant="ghost"
	size="icon"
	class="size-8"
	title={m.settings_sync()}
	aria-label={name ? m.settings_sync_item({ name }) : m.settings_sync()}
	aria-pressed={pressed}
	onclick={() => onchange(!pressed)}
>
	{#if pressed}
		<CloudIcon class="size-4" />
	{:else}
		<CloudOffIcon class="size-4 text-muted-foreground" />
	{/if}
</Button>
