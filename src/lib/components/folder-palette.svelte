<script lang="ts">
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PaletteFrame from '$lib/components/palette-frame.svelte';
	import { hasNoModifiers, isImeKey, toDraftKey, type Platform } from '$lib/keys';
	import { m } from '$lib/paraglide/messages';

	/**
	 * コマンドのアクションを動かすフォルダーへ移る欄（docs/actions.md「作業フォルダー」）。
	 * 今のフォルダーを入れた状態で出し、打ったパスで Enter を押すと移る
	 */
	type Props = {
		/** 今のフォルダー（タイトルバーに出しているのと同じ形） */
		current: string;
		platform: Platform;
		/** 欄を開くキー。開いている間に押すと閉じる。空文字は割り当てなし */
		toggleKey: string;
		/** 打ったパスへ移る。移れなければ、欄の下に出す文言を返す */
		onsubmit: (input: string) => Promise<string | null>;
		onclose: () => void;
	};

	let { current, platform, toggleKey, onsubmit, onclose }: Props = $props();

	// 出すたびに部品ごと作り直すので、開いたときのフォルダーから始まる
	// svelte-ignore state_referenced_locally
	let input = $state(current);
	let error = $state('');
	let submitting = $state(false);

	async function submit() {
		if (submitting) return;
		submitting = true;
		error = (await onsubmit(input)) ?? '';
		submitting = false;
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
			oninput={() => (error = '')}
			onkeydown={onKeydown}
			{@attach (element) => {
				element.focus();
				element.select();
			}}
		/>
	</div>
	{#if error}
		<p id="folder-palette-error" role="alert" class="border-t px-3 py-2 text-sm text-destructive">
			{error}
		</p>
	{/if}
</PaletteFrame>
