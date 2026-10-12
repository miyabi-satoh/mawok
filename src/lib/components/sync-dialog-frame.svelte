<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { m } from '$lib/paraglide/messages';

	/**
	 * 同期の、一覧から選んで実行するダイアログの枠（食い違いを選ぶ・同期の前に戻す）。
	 * 一覧が長くても窓に収まるよう、題名とボタンを残して中身だけを送る
	 */
	let {
		open = $bindable(false),
		title,
		description,
		notice,
		loading,
		busy,
		actionLabel,
		actionDisabled,
		onaction,
		children
	}: {
		open: boolean;
		title: string;
		/** 知らせの上に常に出す説明 */
		description?: string;
		/** 一覧の上に出す知らせ。空なら出さない */
		notice: string;
		/** 一覧を読んでいる途中か */
		loading: boolean;
		/** 実行している最中か。その間はどちらのボタンも押せない */
		busy: boolean;
		actionLabel: string;
		/** 実行するものをまだ選んでいないか */
		actionDisabled: boolean;
		onaction: () => void;
		children: Snippet;
	} = $props();
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Content
		class="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg"
	>
		<AlertDialog.Header>
			<AlertDialog.Title>{title}</AlertDialog.Title>
		</AlertDialog.Header>
		<div class="-mx-4 flex flex-col gap-4 overflow-y-auto px-4">
			{#if description}
				<p class="text-sm text-muted-foreground">{description}</p>
			{/if}
			{#if notice}
				<p role="status" class="text-sm">{notice}</p>
			{/if}
			{#if loading}
				<p role="status" class="text-sm text-muted-foreground">{m.sync_loading()}</p>
			{/if}
			{@render children()}
		</div>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={busy}>{m.common_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action disabled={busy || actionDisabled} onclick={onaction}>
				{actionLabel}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
