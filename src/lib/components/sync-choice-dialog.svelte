<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { untrack } from 'svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import type { SyncChoice } from '$lib/bindings/SyncChoice';
	import type { SyncConflict } from '$lib/bindings/SyncConflict';
	import type { SyncConflictList } from '$lib/bindings/SyncConflictList';
	import type { SyncResolution } from '$lib/bindings/SyncResolution';
	import { errorCode } from '$lib/errors';
	import type { Platform } from '$lib/keys';
	import { m } from '$lib/paraglide/messages';
	import { CHOICE_SIDES, choiceText, sideName, type ChoiceSide } from '$lib/sync-choices';

	/**
	 * このデバイスとほかのデバイスで別々に変えた設定の、どちらを使うかを選ぶ（docs/sync.md「食い違い」）。
	 * ほかのデバイスの値は、開くたびに読み直す
	 */
	let { open = $bindable(false), platform }: { open: boolean; platform: Platform } = $props();

	/** 選ぶ項目。null は読んでいる途中 */
	let conflicts = $state<SyncConflict[] | null>(null);
	/** 項目の id ごとの選択。読んだときは、どれも「あとで選ぶ」 */
	let chosen = $state<Record<string, ChoiceSide>>({});
	/** 一覧の上に出す知らせ（読めなかった・選び直し・使えなかった） */
	let notice = $state('');
	let applying = $state(false);
	/** 読み込みの通し番号。閉じた後や読み直した後に届いた前の答えを捨てる */
	let loads = 0;

	const items = $derived(
		(conflicts ?? []).map((conflict) => ({ conflict, text: choiceText(conflict, platform) }))
	);
	const choices = $derived<SyncChoice[]>(
		(conflicts ?? []).flatMap(({ id, seq }) => {
			const side = chosen[id];
			return side === 'this_device' || side === 'other_device' ? [{ id, seq, side }] : [];
		})
	);

	const failure = (e: unknown) =>
		errorCode(e) === 'sync.unreachable'
			? m.sync_choice_unreachable()
			: m.settings_failed({ error: errorCode(e) });

	async function load(message = '') {
		const load = ++loads;
		conflicts = null;
		chosen = {};
		notice = message;
		try {
			const list = await invoke<SyncConflictList>('sync_conflicts');
			if (load !== loads) return;
			conflicts = list.items;
			chosen = Object.fromEntries(list.items.map(({ id }) => [id, 'later']));
			if (list.items.length > 0) return;
			// 選ぶものが残っていない。読んだときに片付いた（ほかのデバイスが同期から外した行）なら、知らせずに閉じる
			if (list.unreadable) notice = m.sync_choice_unreadable();
			else if (!message) open = false;
		} catch (e) {
			if (load !== loads) return;
			conflicts = [];
			notice = failure(e);
		}
	}

	// 開くのは、呼んだ側（ボタン・トレイからの頼み）なので、開いたことはここで見て読みに行く
	$effect(() => {
		if (open) untrack(() => void load());
		else loads++;
	});

	async function apply() {
		const labels = new Map(items.map(({ conflict, text }) => [conflict.id, text.label]));
		applying = true;
		try {
			const result = await invoke<SyncResolution>('resolve_sync_conflicts', { choices });
			if (result.stale) {
				await load(m.sync_choice_stale());
			} else if (result.rejected.length > 0) {
				const names = result.rejected.map((id) => labels.get(id) ?? id).join(', ');
				await load(m.sync_choice_rejected({ names }));
			} else {
				open = false;
			}
		} catch (e) {
			notice = failure(e);
		} finally {
			applying = false;
		}
	}
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Content
		class="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg"
	>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.sync_choice_title()}</AlertDialog.Title>
		</AlertDialog.Header>
		<div class="-mx-4 flex flex-col gap-4 overflow-y-auto px-4">
			{#if notice}
				<p role="status" class="text-sm">{notice}</p>
			{/if}
			{#if conflicts === null}
				<p role="status" class="text-sm text-muted-foreground">{m.sync_choice_loading()}</p>
			{/if}
			{#each items as { conflict, text } (conflict.id)}
				<fieldset class="flex min-w-0 flex-col gap-1.5">
					<legend class="mb-1.5 text-sm font-medium">{text.label}</legend>
					<div class="grid grid-cols-2 gap-2">
						{#each CHOICE_SIDES as { side, name } (side)}
							<label
								class={[
									'flex min-w-0 flex-col gap-1 rounded-lg p-2 text-sm has-focus-visible:ring-3 has-focus-visible:ring-ring/50',
									// 「あとで選ぶ」は値を持たないので、枠で囲まずに2つの値の下に置く
									side === 'later' ? 'col-span-2' : 'border has-checked:border-primary'
								]}
							>
								<span class="flex items-center gap-2">
									<input
										type="radio"
										class="size-4 accent-primary"
										name="sync-choice-{conflict.id}"
										value={side}
										aria-label={sideName(text.label, side)}
										disabled={applying}
										bind:group={chosen[conflict.id]}
									/>
									{name()}
								</span>
								{#if side !== 'later'}
									<!-- 長い値は切らずに、欄の中で送って読めるようにする。キーボードでも送れるよう、フォーカスを置ける -->
									<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
									<span
										tabindex="0"
										class="max-h-24 overflow-y-auto rounded-sm text-xs leading-snug wrap-anywhere whitespace-pre-wrap text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
									>
										{side === 'this_device' ? text.thisDevice : text.otherDevice}
									</span>
								{/if}
							</label>
						{/each}
					</div>
				</fieldset>
			{/each}
		</div>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={applying}>{m.sync_choice_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action disabled={applying || choices.length === 0} onclick={apply}>
				{m.sync_choice_apply()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
