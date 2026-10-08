<script
	lang="ts"
	generics="T extends { name: string } & Record<K, string>, K extends string = never"
>
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import { dragHandle, dragHandleZone, type DndEvent } from 'svelte-dnd-action';
	import { flip } from 'svelte/animate';
	import { prefersReducedMotion } from 'svelte/motion';
	import type { SvelteSet } from 'svelte/reactivity';
	import { tick, type Snippet } from 'svelte';
	import { m } from '$lib/paraglide/messages';
	import RowMenu from '$lib/components/row-menu.svelte';
	import { buttonVariants } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { matchedIds, shownRows } from '$lib/list-filter';
	import { REORDER_FLIP_DURATION } from '$lib/reorder';
	import type { Row, RowList } from '$lib/row-list.svelte';

	/**
	 * 名前と本文の組を並べて編集する一覧（定型文・アクション）。ふだんは1件1行（grip・名前と本文の頭・「…」メニュー）で見せ、
	 * 行を押すと開いて、名前と本文を編集する。grip でドラッグ、「…」メニューの移動でも並べ替えられる。
	 * 絞り込んでいる間は、並びの一部しか見えないので、並べ替えの操作を出さない
	 */
	type Props = {
		list: RowList<T>;
		/** 開いている行の id。分類を移っても開いたままにするよう、持ち主が持つ */
		expanded: SvelteSet<string>;
		nameLabel: string;
		/** 閉じた行に、名前の横に出す本文の頭 */
		preview: (row: Row<T>) => string;
		/** 本文の頭を等幅の字で出すか（コマンド） */
		monoPreview?: boolean;
		/** 絞り込みの語。空なら絞り込まない */
		query?: string;
		/** 絞り込みで語を探す文字列（名前と本文） */
		searchText: (row: Row<T>) => string[];
		/** 閉じた行の、「…」メニューの前に置くもの（アクションの有効のスイッチ） */
		trailing?: Snippet<[Row<T>]>;
		/** 閉じた行の名前と本文の頭を薄く出すか（切ったアクション） */
		dimmed?: (row: Row<T>) => boolean;
	} & (
		| {
				/** 本文を持つ項目の名前（定型文は body） */
				bodyKey: K;
				bodyLabel: string;
				body?: never;
		  }
		| {
				/** 本文の欄の代わりに描くもの（アクション）。書き換えたら list.save() を呼ぶ */
				body: Snippet<[Row<T>]>;
				bodyKey?: never;
				bodyLabel?: never;
		  }
	);

	let {
		list,
		expanded,
		nameLabel,
		preview,
		monoPreview = false,
		query = '',
		searchText,
		trailing,
		dimmed,
		...bodyProps
	}: Props = $props();

	/** ドラッグの並べ替えのアニメーションの長さ。動きを減らす設定なら 0 にする */
	const flipDurationMs = $derived(prefersReducedMotion.current ? 0 : REORDER_FLIP_DURATION);
	/** 絞り込みに当たった行の id。語を変えたときにだけ求め直す。null なら絞り込んでいない */
	const matched = $derived(matchedIds(() => list.rows, query, searchText));
	const shown = $derived(shownRows(list.rows, matched));

	function consider(e: CustomEvent<DndEvent<Row<T>>>) {
		list.consider(e.detail.items);
	}

	function finalize(e: CustomEvent<DndEvent<Row<T>>>) {
		list.finalize(e.detail.items);
	}

	/** 行の並び。消した後に、隣の行の「…」へフォーカスを移すのに使う */
	let rowsEl = $state<HTMLElement | null>(null);

	/**
	 * 行を消し、見えている並びで同じ位置の行（末尾を消したなら1つ前の行）の「…」へフォーカスを移す。
	 * メニューは閉じると「…」へフォーカスを戻すが、その行ごと消えるので、そのままでは body に外れて
	 * キーボードでの操作が途切れるため
	 */
	async function remove(row: Row<T>) {
		const position = shown.indexOf(row);
		expanded.delete(row.id);
		list.remove(list.rows.indexOf(row));
		await tick();
		const menus = rowsEl?.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-trigger"]');
		if (!menus?.length) return;
		menus[Math.min(position, menus.length - 1)].focus();
	}

	function toggle(id: string) {
		if (expanded.has(id)) expanded.delete(id);
		else expanded.add(id);
	}
</script>

{#if matched !== null && shown.length === 0}
	<p class="px-1 text-sm text-muted-foreground">{m.settings_filter_no_match()}</p>
{:else if shown.length > 0}
	<div
		bind:this={rowsEl}
		class="flex flex-col gap-1"
		use:dragHandleZone={{
			items: shown,
			flipDurationMs,
			dropTargetStyle: {},
			dragDisabled: matched !== null
		}}
		onconsider={consider}
		onfinalize={finalize}
	>
		{#each shown as row (row.id)}
			{@const index = list.rows.indexOf(row)}
			{@const open = expanded.has(row.id)}
			{@const head = preview(row)}
			<div class="flex flex-col gap-2" animate:flip={{ duration: flipDurationMs }}>
				<div class="flex items-center gap-1">
					{#if matched === null}
						<!--
							dragHandle は grip の要素そのものに付けるので、Button でなく素の要素にする。button だと
							ネイティブの .value（既定値 ""）が svelte-dnd-action の「入力欄からのドラッグ開始を防ぐガード」に
							引っかかり、ドラッグが始まらない（role="button" と tabindex は dragHandle が付ける）
						-->
						<div
							use:dragHandle
							aria-label={m.settings_reorder_drag()}
							class="{buttonVariants({
								variant: 'ghost',
								size: 'icon'
							})} cursor-grab touch-none active:cursor-grabbing"
						>
							<GripVerticalIcon class="size-4" />
						</div>
					{/if}
					<button
						type="button"
						class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
						aria-expanded={open}
						aria-controls="row-{row.id}"
						onclick={() => toggle(row.id)}
					>
						<ChevronRightIcon
							class="size-4 shrink-0 text-muted-foreground transition-transform {open
								? 'rotate-90'
								: ''}"
							strokeWidth={1.5}
							aria-hidden="true"
						/>
						<span class="flex min-w-0 items-center gap-2 {dimmed?.(row) ? 'opacity-50' : ''}">
							{#if row.name}
								<!-- 名前は縮めず本文の頭から詰めるが、行より長い名前は行の幅で切る -->
								<span class="max-w-full shrink-0 truncate font-medium">{row.name}</span>
							{:else if !head}
								<!-- 足した直後の空の行にも、見える名前と読み上げの名前を持たせる -->
								<span class="text-muted-foreground">{m.settings_row_empty()}</span>
							{/if}
							<span class="truncate text-muted-foreground {monoPreview ? 'font-mono text-xs' : ''}"
								>{head}</span
							>
						</span>
					</button>
					{@render trailing?.(row)}
					<RowMenu
						name={row.name || head}
						{index}
						count={list.rows.length}
						reorderable={matched === null}
						onmove={(to) => list.move(index, to)}
						onremove={() => remove(row)}
					/>
				</div>
				{#if open}
					<div id="row-{row.id}" class="mb-2 flex flex-col gap-2 pl-8">
						<Input
							class="min-w-0 text-sm"
							aria-label={nameLabel}
							bind:value={
								() => row.name,
								(name) => {
									row.name = name;
									list.save();
								}
							}
						/>
						{#if bodyProps.body}
							{@render bodyProps.body(row)}
						{:else}
							{@const bodyKey = bodyProps.bodyKey}
							<Textarea
								class="min-h-20 text-sm"
								aria-label={bodyProps.bodyLabel}
								bind:value={
									() => row[bodyKey],
									(body) => {
										row[bodyKey] = (body ?? '') as Row<T>[K];
										list.save();
									}
								}
							/>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}
