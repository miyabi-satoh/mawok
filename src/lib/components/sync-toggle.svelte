<script lang="ts">
	import CloudIcon from '@lucide/svelte/icons/cloud';
	import CloudOffIcon from '@lucide/svelte/icons/cloud-off';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';

	/**
	 * 一覧の1行や設定を同期するかの印。意味の説明は一覧や区分の上に一度だけ出すので、ここには置かない。
	 * name は読み上げで項目を見分けるためのもの。設定の見出しに置くときは compact にする
	 * compact は、inline にした見出しの後ろに続けて置ける（align-middle）。見出しが折れる行で、印を箱の右でなく最後の語の直後に付けるため
	 */
	let {
		pressed,
		name = '',
		compact = false,
		settingName,
		onchange
	}: {
		pressed: boolean;
		name?: string;
		compact?: boolean;
		settingName?: string;
		onchange: (pressed: boolean) => void;
	} = $props();
</script>

<Button
	variant="ghost"
	size="icon"
	class={compact ? 'size-6 align-middle' : 'size-8'}
	data-sync-setting={settingName}
	title={m.settings_sync()}
	aria-label={name ? m.settings_sync_item({ name }) : m.settings_sync()}
	aria-pressed={pressed}
	onclick={() => onchange(!pressed)}
>
	{#if pressed}
		<CloudIcon class={compact ? 'size-3.5' : 'size-4'} />
	{:else}
		<CloudOffIcon
			class={compact ? 'size-3.5 text-muted-foreground' : 'size-4 text-muted-foreground'}
		/>
	{/if}
</Button>
