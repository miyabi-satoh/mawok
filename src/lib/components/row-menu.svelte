<script lang="ts">
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowDownToLineIcon from '@lucide/svelte/icons/arrow-down-to-line';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowUpToLineIcon from '@lucide/svelte/icons/arrow-up-to-line';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { buttonVariants } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { m } from '$lib/paraglide/messages';

	/**
	 * 定型文・アクションの行の「…」メニュー。移動と削除をまとめる。ドラッグ（grip）だけだと
	 * キーボードで並べ替えられないため、移動をここに置く（Atlassian の drag and drop の指針と同じ形）。
	 * 削除を1手深くして、押し間違いで消えにくくもする
	 */
	let {
		name,
		index,
		count,
		reorderable,
		onmove,
		onremove
	}: {
		/** 読み上げでどの行のメニューか分かるよう、ボタンの名前に入れる。空なら「この行」と言う */
		name: string;
		index: number;
		count: number;
		/** 移動の項目を出すか。絞り込んでいる間は、並びの一部しか見えないので出さない */
		reorderable: boolean;
		onmove: (to: number) => void;
		onremove: () => void;
	} = $props();

	const last = $derived(count - 1);
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class={buttonVariants({ variant: 'ghost', size: 'icon' })}
		aria-label={name ? m.settings_row_menu({ name }) : m.settings_row_menu_unnamed()}
	>
		<EllipsisIcon />
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-auto">
		{#if reorderable && count > 1}
			<DropdownMenu.Item disabled={index === 0} onSelect={() => onmove(index - 1)}>
				<ArrowUpIcon />
				{m.settings_reorder_up()}
			</DropdownMenu.Item>
			<DropdownMenu.Item disabled={index === last} onSelect={() => onmove(index + 1)}>
				<ArrowDownIcon />
				{m.settings_reorder_down()}
			</DropdownMenu.Item>
			<DropdownMenu.Item disabled={index === 0} onSelect={() => onmove(0)}>
				<ArrowUpToLineIcon />
				{m.settings_reorder_top()}
			</DropdownMenu.Item>
			<DropdownMenu.Item disabled={index === last} onSelect={() => onmove(last)}>
				<ArrowDownToLineIcon />
				{m.settings_reorder_bottom()}
			</DropdownMenu.Item>
			<DropdownMenu.Separator />
		{/if}
		<DropdownMenu.Item variant="destructive" onSelect={onremove}>
			<Trash2Icon />
			{m.settings_row_remove()}
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
