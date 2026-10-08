<script lang="ts" module>
	import SearchIcon from '@lucide/svelte/icons/search';

	/** 一覧の端に添える操作の項目。選ぶと run を呼ぶ */
	export type PaletteAction = {
		label: string;
		/** 見出しの下に添える1行。なければ空文字 */
		preview: string;
		icon?: typeof SearchIcon;
		run: () => void;
	};
</script>

<script lang="ts" generics="T extends NamedText">
	import { clamp } from '$lib/clamp';
	import PaletteFrame from '$lib/components/palette-frame.svelte';
	import { hasNoModifiers, isImeKey, toDraftKey, type Platform } from '$lib/keys';
	import { filterSnippets, snippetLabel, snippetPreview, type NamedText } from '$lib/snippets';

	/**
	 * 名前と本文の組を選ぶ一覧。定型文の一覧とアクションの一覧で使い、出し方・絞り込み・選び方・閉じ方を揃える
	 */
	type Props = {
		items: T[];
		platform: Platform;
		/** 一覧を開くキー。開いている間に押すと閉じる。空文字は割り当てなし */
		toggleKey: string;
		/** 一覧の名前（ダイアログと項目の並び） */
		listLabel: string;
		/** 絞り込みの欄の名前 */
		searchLabel: string;
		/** 選べるものが1件もないときの案内 */
		emptyMessage: string;
		/** 絞り込んで1件も残らないときの案内 */
		noMatchMessage: string;
		/**
		 * 一覧の端に添える操作の項目。絞り込みの文字を受け取り、出さないときは null を返す
		 * （アクションの「この内容で実行」、定型文の「テキストを定型文に登録」）
		 */
		action?: (query: string) => PaletteAction | null;
		/** 操作の項目を先頭と末尾のどちらに添えるか */
		actionAt?: 'start' | 'end';
		/** 選んだ1件を受け取る */
		onpick: (item: T) => void;
		/** 選ばずに閉じる */
		onclose: () => void;
	};

	let {
		items: all,
		platform,
		toggleKey,
		listLabel,
		searchLabel,
		emptyMessage,
		noMatchMessage,
		action,
		actionAt = 'start',
		onpick,
		onclose
	}: Props = $props();

	const id = $props.id();
	// 出すたびに部品ごと作り直すので、絞り込みは空から始まる
	let query = $state('');
	let active = $state(0);
	const usable = $derived(filterSnippets(all, ''));
	const filtered = $derived(filterSnippets(all, query));
	type Entry = Omit<PaletteAction, 'run'> & { pick: () => void };
	// 絞り込んだ項目と、端に添える操作の項目を、選ぶ・描く側からは同じに扱う
	const items = $derived.by(() => {
		const entries: Entry[] = filtered.map((item) => ({
			label: snippetLabel(item),
			preview: snippetPreview(item),
			pick: () => onpick(item)
		}));
		const extra = action?.(query);
		if (!extra) return entries;
		const entry: Entry = { ...extra, pick: extra.run };
		return actionAt === 'start' ? [entry, ...entries] : [...entries, entry];
	});
	// アイコンのある行があれば、ない行にもその幅を空ける
	const hasIcons = $derived(items.some((item) => item.icon));
	// 当たる項目がなければ、操作の項目があっても案内を出す。案内は、項目があるはずの側に置く
	const status = $derived(
		filtered.length > 0 ? null : usable.length === 0 ? emptyMessage : noMatchMessage
	);
	// 開いている間に設定が変わって件数が減っても、一覧の外を選ばないようにする
	const selected = $derived(Math.min(active, items.length - 1));

	function onKeydown(event: KeyboardEvent) {
		// IME が処理したキーは、変換の操作なので横取りしない
		if (isImeKey(event)) return;
		if (toggleKey && toDraftKey(event, platform) === toggleKey) {
			event.preventDefault();
			onclose();
			return;
		}
		// フォーカスを取るのは絞り込みの欄だけなので、Tab で一覧の外（後ろの下書き）へ抜けないようにする。
		// 抜けると、一覧が出たまま見えない入力欄に文字が入る
		if (event.key === 'Tab') {
			event.preventDefault();
			return;
		}
		// 修飾キー付きのキー（Cmd+Enter など）は一覧の操作に使わない
		if (!hasNoModifiers(event)) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onclose();
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			active = clamp(selected + step, 0, items.length - 1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			items[selected]?.pick();
		}
	}
</script>

{#snippet statusLine(message: string)}
	<p role="status" class="px-3 py-6 text-center text-sm text-muted-foreground">{message}</p>
{/snippet}

<!-- 下は、送り先の一覧と同じく、下書きの下の列に重ならないよう 2.75rem 空ける -->
<PaletteFrame label={listLabel} maxHeightClass="max-h-[calc(100%-4.5rem)]" {onclose}>
	<div class="flex h-9 shrink-0 items-center gap-2 border-b px-3">
		<SearchIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<!-- プレースホルダーは置かない。欄の意味は aria-label と虫眼鏡で示す -->
		<input
			role="combobox"
			aria-expanded="true"
			aria-controls="{id}-list"
			aria-activedescendant={items.length > 0 ? `${id}-option-${selected}` : undefined}
			aria-label={searchLabel}
			class="h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
			autocomplete="off"
			spellcheck="false"
			bind:value={query}
			oninput={() => (active = 0)}
			onkeydown={onKeydown}
			{@attach (element) => element.focus()}
		/>
	</div>
	{#if status && actionAt === 'end'}
		{@render statusLine(status)}
	{/if}
	{#if items.length > 0}
		<ul
			id="{id}-list"
			role="listbox"
			aria-label={listLabel}
			class="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-1"
		>
			{#each items as item, index (index)}
				<!-- キーボードでは絞り込みの欄の ↑↓ と Enter で選ぶので、項目自体はフォーカスを取らない -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					id="{id}-option-{index}"
					role="option"
					aria-selected={index === selected}
					class="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 aria-selected:bg-accent aria-selected:text-accent-foreground"
					onpointerdown={(event) => event.preventDefault()}
					onpointermove={() => (active = index)}
					onclick={item.pick}
					{@attach (element) => {
						if (index === selected) element.scrollIntoView({ block: 'nearest' });
					}}
				>
					{#if item.icon}
						<item.icon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					{:else if hasIcons}
						<!-- アイコンのある行（「テキストを定型文に登録」など）と、文字の左端を揃える -->
						<span class="size-4 shrink-0" aria-hidden="true"></span>
					{/if}
					<span class="flex min-w-0 flex-col gap-0.5">
						<span class="truncate text-sm font-medium">{item.label}</span>
						{#if item.preview}
							<span class="truncate text-xs text-muted-foreground">{item.preview}</span>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
	{#if status && actionAt === 'start'}
		{@render statusLine(status)}
	{/if}
</PaletteFrame>
