<script lang="ts">
	import FolderIcon from '@lucide/svelte/icons/folder';
	import { tick } from 'svelte';
	import type { FolderCompletion } from '$lib/bindings/FolderCompletion';
	import PaletteFrame from '$lib/components/palette-frame.svelte';
	import { stepSelection, suggestionSuffix } from '$lib/folder-completion';
	import { hasNoModifiers, isImeKey, toDraftKey, type Platform } from '$lib/keys';
	import { m } from '$lib/paraglide/messages';

	/**
	 * コマンドのアクションを動かすフォルダーへ移る欄（docs/actions.md「作業フォルダー」）。
	 * 今のフォルダーを入れた状態で出し、打ったパスで Enter を押すと移る。
	 * 補い方はシェルに合わせる。Tab で打ちかけのフォルダーの名前を補い、候補が並んだらもう一度 Tab で順に選ぶ（zsh の menu-select）。
	 * 打っている間は、1つに決まる続きを薄く出し、→ か Tab で受け入れる（fish の autosuggestion）
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
	// 補った候補（区切りまで付いた名前）と、選んだら候補をつなぐ土台。打ち直すと消す
	let candidates = $state<string[]>([]);
	let total = $state(0);
	let base = '';
	// 選んでいる候補。-1 は選んでいない。選ぶ前の欄の中身は、Esc で戻すために取っておく
	let selected = $state(-1);
	let beforeMenu = '';
	// 薄く出す続き。カーソルが末尾に無いときと、欄からはみ出しているときは出さない（続きの位置が打った文字とずれるため）
	let suggestion = $state('');
	// 続きを受け入れたときの欄の中身。打った所の大文字と小文字も実際の名前に合わせるため、続きをつながずにこれを入れる
	let suggested = '';
	let inputElement: HTMLInputElement | undefined;
	// 打つ・Enter・Tab のたびに進める。補いを待つ間に進んでいたら、古いパスの補いで上書きしない
	let edits = 0;

	function clearCandidates() {
		edits += 1;
		candidates = [];
		total = 0;
		selected = -1;
		suggestion = '';
	}

	async function moveCaretToEnd() {
		await tick();
		inputElement?.setSelectionRange(input.length, input.length);
	}

	/** 今の欄の中身で、1つに決まる続きがあれば薄く出す */
	async function suggest() {
		const requested = edits;
		const typed = input;
		const completion = await oncomplete(typed);
		if (!completion || edits !== requested || !inputElement) return;
		const atEnd = caretAtEnd();
		const fits = inputElement.scrollWidth <= inputElement.clientWidth;
		suggestion = atEnd && fits ? suggestionSuffix(typed, completion) : '';
		suggested = completion.input;
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
		suggestion = '';
		const typed = input;
		const completion = await oncomplete(typed);
		if (!completion || edits !== requested) return;
		input = completion.input;
		error = '';
		candidates = completion.candidates;
		total = completion.total;
		base = completion.base;
		await moveCaretToEnd();
		// 補えたときだけ、補った先の続きを探す。補えなければ、同じパスを問い合わせ直すことになる
		if (candidates.length === 0 && input !== typed) void suggest();
	}

	/** 並んでいる候補を、順に選んで欄に入れる */
	async function select(step: 1 | -1) {
		if (selected < 0) beforeMenu = input;
		selected = stepSelection(selected, candidates.length, step);
		input = base + candidates[selected];
		await moveCaretToEnd();
		document.getElementById(`folder-candidate-${selected}`)?.scrollIntoView({ block: 'nearest' });
	}

	/** 選んだ候補で決める。続けて Tab でその中を補ったり、Enter で移ったりできる */
	async function accept(index: number) {
		input = base + candidates[index];
		clearCandidates();
		inputElement?.focus();
		await moveCaretToEnd();
		void suggest();
	}

	function cancelMenu() {
		input = beforeMenu;
		selected = -1;
		void moveCaretToEnd();
	}

	async function acceptSuggestion() {
		input = suggested;
		clearCandidates();
		await moveCaretToEnd();
		void suggest();
	}

	/** カーソルが末尾にあり、文字を選んでいないか */
	function caretAtEnd(): boolean {
		return (
			inputElement?.selectionStart === input.length && inputElement.selectionEnd === input.length
		);
	}

	function onKeydown(event: KeyboardEvent) {
		// IME が処理したキーは、変換の操作なので横取りしない
		if (isImeKey(event)) return;
		if (toggleKey && toDraftKey(event, platform) === toggleKey) {
			event.preventDefault();
			onclose();
			return;
		}
		const listed = candidates.length > 0;
		// 欄の外（後ろの下書き）へ抜けると、欄が出たまま見えない入力欄に文字が入るので、Tab で抜けないようにする
		if (event.key === 'Tab') {
			event.preventDefault();
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (listed) void select(event.shiftKey ? -1 : 1);
			else if (event.shiftKey) return;
			else if (suggestion && caretAtEnd()) void acceptSuggestion();
			else void complete();
			return;
		}
		if (!hasNoModifiers(event)) return;
		if (listed && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
			event.preventDefault();
			void select(event.key === 'ArrowDown' ? 1 : -1);
		} else if (event.key === 'ArrowRight' && suggestion && caretAtEnd()) {
			event.preventDefault();
			void acceptSuggestion();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			// 選んでいれば選ぶ前に、候補が並んでいれば一覧を閉じるだけにし、打ったパスを残す
			if (selected >= 0) cancelMenu();
			else if (candidates.length > 0) clearCandidates();
			else onclose();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (selected >= 0) void accept(selected);
			else void submit();
		}
	}

	// カーソルが末尾から離れたか。末尾へ戻ったときに続きを出し直すために覚えておく。欄は中身を選んだ状態で開くので、離れた側から始める
	let leftEnd = true;

	/**
	 * カーソルが末尾から離れたら続きを消し、末尾へ戻ったら出し直す。
	 * 動かし方（←→・Home・End・Cmd+←・↑・押すなど）はキーで決めきれないので、キーを離すたびと押すたびにカーソルの位置で見る
	 */
	function onCaretMove() {
		if (!caretAtEnd()) {
			suggestion = '';
			leftEnd = true;
		} else if (leftEnd) {
			leftEnd = false;
			if (candidates.length === 0) void suggest();
		}
	}
</script>

<PaletteFrame label={m.folder_palette()} maxHeightClass="max-h-[calc(100%-4.5rem)]" {onclose}>
	<div class="flex h-9 shrink-0 items-center gap-2 px-3">
		<FolderIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<!--
			プレースホルダーは置かない。欄の意味は aria-label とフォルダーのアイコンで示す。
			薄く出す続きは、欄に重ねた同じ書体の層に、打った所を見えなくして並べ、続きだけを見せる
		-->
		<div class="relative h-full min-w-0 flex-1">
			<input
				role="combobox"
				aria-label={m.folder_input()}
				aria-expanded={candidates.length > 0}
				aria-controls={candidates.length > 0 ? 'folder-candidates' : undefined}
				aria-autocomplete="both"
				aria-activedescendant={selected >= 0 ? `folder-candidate-${selected}` : undefined}
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={error ? 'folder-palette-error' : undefined}
				class="h-full w-full bg-transparent text-sm outline-none"
				autocomplete="off"
				spellcheck="false"
				bind:value={input}
				oninput={(event) => {
					error = '';
					clearCandidates();
					// 変換中の文字は確定するまで続きの元にしない
					if (!(event instanceof InputEvent && event.isComposing)) void suggest();
				}}
				oncompositionend={() => void suggest()}
				onkeydown={onKeydown}
				onkeyup={onCaretMove}
				onpointerup={onCaretMove}
				bind:this={inputElement}
				{@attach (element) => {
					element.focus();
					element.select();
				}}
			/>
			{#if suggestion}
				<div
					aria-hidden="true"
					data-testid="folder-suggestion"
					class="pointer-events-none absolute inset-0 flex items-center overflow-hidden text-sm whitespace-pre"
				>
					<span class="invisible">{input}</span><span class="text-muted-foreground/70"
						>{suggestion}</span
					>
				</div>
			{/if}
		</div>
	</div>
	<!--
		Tab を押してもフォーカスは欄から動かないので、候補が出たことを読み上げで知らせる。一覧ごと読むと長いので、件数だけを読む。
		読み上げは、前からある領域の中身が変わったときに働くので、領域はいつも置く
	-->
	<p aria-live="polite" class="sr-only">
		{candidates.length > 0 ? m.folder_candidates_count({ count: total }) : ''}
	</p>
	{#if candidates.length > 0}
		<div class="min-h-0 overflow-y-auto border-t px-2 py-2 text-sm text-muted-foreground">
			<ul
				id="folder-candidates"
				role="listbox"
				aria-label={m.folder_candidates()}
				class="flex flex-wrap gap-x-2 gap-y-0.5"
			>
				{#each candidates as name, index (name)}
					<!-- 押しても欄からフォーカスを動かさず、その候補で決める -->
					<li
						id="folder-candidate-{index}"
						role="option"
						aria-selected={index === selected}
						class={[
							'min-w-0 cursor-default rounded px-1 break-all',
							index === selected && 'bg-accent text-accent-foreground'
						]}
						onpointerdown={(event) => {
							event.preventDefault();
							void accept(index);
						}}
					>
						{name}
					</li>
				{/each}
			</ul>
			{#if total > candidates.length}
				<p class="mt-1 px-1">{m.folder_candidates_more({ count: total - candidates.length })}</p>
			{/if}
		</div>
	{/if}
	{#if error}
		<p id="folder-palette-error" role="alert" class="border-t px-3 py-2 text-sm text-destructive">
			{error}
		</p>
	{/if}
</PaletteFrame>
