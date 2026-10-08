<script lang="ts">
	import type { Snippet } from 'svelte';

	/** 下書きの上に出す一覧（定型文・アクション・送り先）の枠。後ろを薄く覆い、その上に一覧を出す */
	type Props = {
		/** 一覧の名前 */
		label: string;
		/** 一覧の高さの上限（max-h-* のクラス）。下書きの下に残す列の高さが一覧ごとに違う */
		maxHeightClass: string;
		/** 一覧の外を押したとき */
		onclose: () => void;
		children: Snippet;
	};

	let { label, maxHeightClass, onclose, children }: Props = $props();
</script>

<!-- 一覧の外（後ろの下書き）を押したら閉じる。キーボードでは Esc で閉じる（一覧の側で受ける） -->
<div
	class="absolute inset-0 bg-black/10 dark:bg-black/40"
	aria-hidden="true"
	onpointerdown={(event) => {
		event.preventDefault();
		onclose();
	}}
></div>
<!--
	下書きの窓は小さいので、上下に余白を残して、入りきらない分は一覧の中でスクロールする。
	ダークでは後ろを暗く覆う色と一覧の地の色が近く、縁が溶けるので、枠を濃くする
-->
<div
	role="dialog"
	aria-label={label}
	class={[
		'absolute inset-x-0 top-7 mx-auto flex',
		maxHeightClass,
		'w-[min(27.5rem,calc(100%-2rem))] flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 dark:ring-foreground/25'
	]}
>
	{@render children()}
</div>
