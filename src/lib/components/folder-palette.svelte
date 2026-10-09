<script lang="ts">
	import FolderIcon from '@lucide/svelte/icons/folder';
	import { tick } from 'svelte';
	import type { FolderCompletion } from '$lib/bindings/FolderCompletion';
	import PaletteFrame from '$lib/components/palette-frame.svelte';
	import { hasNoModifiers, isImeKey, toDraftKey, type Platform } from '$lib/keys';
	import { m } from '$lib/paraglide/messages';

	/**
	 * コマンドのアクションを動かすフォルダーへ移る欄（docs/actions.md「作業フォルダー」）。
	 * 今のフォルダーを入れた状態で出し、打ったパスで Enter を押すと移る。Tab で打ちかけのフォルダーの名前を補う
	 */
	type Props = {
		/** 今のフォルダー（タイトルバーに出しているのと同じ形） */
		current: string;
		platform: Platform;
		/** 欄を開くキー。開いている間に押すと閉じる。空文字は割り当てなし */
		toggleKey: string;
		/** 打ったパスへ移る。移れなければ、欄の下に出す文言を返す */
		onsubmit: (input: string) => Promise<string | null>;
		/** 打ちかけのパスを補う。補えなければ null */
		oncomplete: (input: string) => Promise<FolderCompletion | null>;
		onclose: () => void;
	};

	let { current, platform, toggleKey, onsubmit, oncomplete, onclose }: Props = $props();

	// 出すたびに部品ごと作り直すので、開いたときのフォルダーから始まる
	// svelte-ignore state_referenced_locally
	let input = $state(current);
	let error = $state('');
	let submitting = $state(false);
	// 補った候補。打ち直すと消す
	let candidates = $state<string[]>([]);
	let total = $state(0);
	let inputElement: HTMLInputElement | undefined;
	// 打つ・Enter・Tab のたびに進める。補いを待つ間に進んでいたら、古いパスの補いで上書きしない
	let edits = 0;

	function clearCandidates() {
		edits += 1;
		candidates = [];
		total = 0;
	}

	async function submit() {
		if (submitting) return;
		submitting = true;
		clearCandidates();
		error = (await onsubmit(input)) ?? '';
		submitting = false;
	}

	async function complete() {
		edits += 1;
		const requested = edits;
		const completion = await oncomplete(input);
		if (!completion || edits !== requested) return;
		input = completion.input;
		error = '';
		candidates = completion.candidates;
		total = completion.total;
		await tick();
		inputElement?.setSelectionRange(input.length, input.length);
	}

	function onKeydown(event: KeyboardEvent) {
		// IME が処理したキーは、変換の操作なので横取りしない
		if (isImeKey(event)) return;
		if (toggleKey && toDraftKey(event, platform) === toggleKey) {
			event.preventDefault();
			onclose();
			return;
		}
		// 欄の外（後ろの下書き）へ抜けると、欄が出たまま見えない入力欄に文字が入るので、Tab で抜けないようにする
		if (event.key === 'Tab') {
			event.preventDefault();
			if (hasNoModifiers(event)) void complete();
			return;
		}
		if (!hasNoModifiers(event)) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onclose();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			void submit();
		}
	}
</script>

<PaletteFrame label={m.folder_palette()} maxHeightClass="max-h-[calc(100%-4.5rem)]" {onclose}>
	<div class="flex h-9 shrink-0 items-center gap-2 px-3">
		<FolderIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<!-- プレースホルダーは置かない。欄の意味は aria-label とフォルダーのアイコンで示す -->
		<input
			aria-label={m.folder_input()}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={error ? 'folder-palette-error' : undefined}
			class="h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
			autocomplete="off"
			spellcheck="false"
			bind:value={input}
			oninput={() => {
				error = '';
				clearCandidates();
			}}
			onkeydown={onKeydown}
			bind:this={inputElement}
			{@attach (element) => {
				element.focus();
				element.select();
			}}
		/>
	</div>
	<!--
		Tab を押してもフォーカスは欄から動かないので、候補が出たことを読み上げで知らせる。一覧ごと読むと長いので、件数だけを読む。
		読み上げは、前からある領域の中身が変わったときに働くので、領域はいつも置く
	-->
	<p aria-live="polite" class="sr-only">
		{candidates.length > 0 ? m.folder_candidates_count({ count: total }) : ''}
	</p>
	{#if candidates.length > 0}
		<div class="min-h-0 overflow-y-auto border-t px-3 py-2 text-sm text-muted-foreground">
			<ul aria-label={m.folder_candidates()} class="flex flex-wrap gap-x-4 gap-y-1">
				{#each candidates as name (name)}
					<li class="min-w-0 break-all">{name}</li>
				{/each}
			</ul>
			{#if total > candidates.length}
				<p class="mt-1">{m.folder_candidates_more({ count: total - candidates.length })}</p>
			{/if}
		</div>
	{/if}
	{#if error}
		<p id="folder-palette-error" role="alert" class="border-t px-3 py-2 text-sm text-destructive">
			{error}
		</p>
	{/if}
</PaletteFrame>
