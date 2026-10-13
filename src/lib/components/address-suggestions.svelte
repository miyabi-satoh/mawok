<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { AddressCandidate } from '$lib/addressee';

	/**
	 * テキストウィンドウの1行目で `@` を打っている間に出す、宛先の候補。
	 * フォーカスは入力欄に置いたままにし、キーは入力欄の側で受ける（打ち続けて絞り込めるように）
	 */
	type Props = {
		/** 入力欄の aria-controls・aria-activedescendant と結ぶ id */
		id: string;
		/** 入力欄の上端からの位置（px）。1行目のすぐ下に出す */
		top: number;
		candidates: AddressCandidate[];
		/** 今選んでいる候補の位置 */
		active: number;
		onpick: (candidate: AddressCandidate) => void;
	};

	let { id, top, candidates, active, onpick }: Props = $props();

	const hints: Record<AddressCandidate['kind'], () => string> = {
		ai: m.draft_address_ai,
		sh: m.draft_address_sh
	};
</script>

<!-- 入力欄からフォーカスを奪わないよう、押したときの既定の動作（フォーカスの移動）を止めてから選ぶ -->
<ul
	{id}
	role="listbox"
	aria-label={m.draft_address_list()}
	style="top: {top}px"
	class="absolute left-2 z-20 max-h-48 max-w-[calc(100%-1rem)] overflow-y-auto rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
>
	{#each candidates as candidate, index (candidate.address)}
		<li
			id="{id}-{index}"
			role="option"
			aria-selected={index === active}
			class={[
				'flex cursor-default items-baseline gap-3 rounded-sm px-2 py-1',
				index === active && 'bg-accent text-accent-foreground'
			]}
			onmousedown={(event) => {
				event.preventDefault();
				onpick(candidate);
			}}
		>
			<span class="font-mono whitespace-nowrap">{candidate.address}</span>
			<span class="text-xs whitespace-nowrap text-muted-foreground">{hints[candidate.kind]()}</span>
		</li>
	{/each}
</ul>
