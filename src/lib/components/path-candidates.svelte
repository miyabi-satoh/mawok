<script lang="ts">
	import { m } from '$lib/paraglide/messages';

	/**
	 * テキストウィンドウの `@sh` の行で Tab を押して、当てはまるパスが2つ以上あったときに並べる候補。
	 * フォーカスは入力欄に置いたままにし、キーは入力欄の側で受ける（宛先の候補と同じ）
	 */
	type Props = {
		/** 入力欄の aria-controls・aria-activedescendant と結ぶ id */
		id: string;
		/** 入力欄の上端からの位置（px）。1行目のすぐ下に出す */
		top: number;
		/** 名前（フォルダーは区切りまで） */
		candidates: string[];
		/** 当てはまる数。並べるのは上限まで */
		total: number;
		/** 選んでいる候補。-1 は選んでいない */
		selected: number;
		onpick: (index: number) => void;
	};

	let { id, top, candidates, total, selected, onpick }: Props = $props();
</script>

<!-- 入力欄からフォーカスを奪わないよう、押したときの既定の動作（フォーカスの移動）を止めてから選ぶ -->
<div
	style="top: {top}px"
	class="absolute left-2 z-20 max-h-48 max-w-[calc(100%-1rem)] overflow-y-auto rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
>
	<ul
		{id}
		role="listbox"
		aria-label={m.draft_path_candidates()}
		class="flex flex-wrap gap-x-2 gap-y-0.5"
	>
		{#each candidates as name, index (name)}
			<!-- 選んだ候補は、短い名前が並ぶ中で見分けられるよう、zsh の menu-select と同じく反転して出す -->
			<li
				id="{id}-{index}"
				role="option"
				aria-selected={index === selected}
				class={[
					'min-w-0 cursor-default rounded px-1 font-mono break-all',
					index === selected && 'bg-primary text-primary-foreground'
				]}
				onpointerdown={(event) => {
					event.preventDefault();
					onpick(index);
				}}
			>
				{name}
			</li>
		{/each}
	</ul>
	{#if total > candidates.length}
		<p class="mt-1 px-1 text-muted-foreground">
			{m.folder_candidates_more({ count: total - candidates.length })}
		</p>
	{/if}
</div>
