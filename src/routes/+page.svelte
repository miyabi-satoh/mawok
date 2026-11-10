<script lang="ts">
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import BookmarkPlusIcon from '@lucide/svelte/icons/bookmark-plus';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import TextQuoteIcon from '@lucide/svelte/icons/text-quote';
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import { onMount, tick } from 'svelte';
	import KeyCaps from '$lib/components/key-caps.svelte';
	import TextPalette, { type PaletteAction } from '$lib/components/text-palette.svelte';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { DEFAULT_DRAFT_FONT_SIZE, draftFontFamily } from '$lib/font';
	import { draftGuidance, guidanceHotkey } from '$lib/guidance';
	import { errorCode, settingsSaveProblem } from '$lib/errors';
	import { insertAsTyped } from '$lib/insert-text';
	import {
		DEFAULT_DRAFT_HISTORY_SIZE,
		DraftHistory,
		historyDirection,
		type HistoryDirection
	} from '$lib/history.svelte';
	import { historyPreview, type HistoryItem } from '$lib/history-search';
	import { caretLine } from '$lib/caret-line';
	import { clamp } from '$lib/clamp';
	import {
		draftActionFor,
		formatKeys,
		isDismissKey,
		isTabKey,
		keyHint,
		type DraftAction
	} from '$lib/keys';
	import { keepsDraftFocus } from '$lib/draft-focus';
	import { m } from '$lib/paraglide/messages';
	import { EVENTS } from '$lib/bindings/constants';
	import { coalescedSaver } from '$lib/saver';
	import {
		previewSegments,
		ReplacementPreview,
		type ReplacementMatch
	} from '$lib/replacement-preview.svelte';
	import { settings, type Snippet } from '$lib/settings.svelte';
	import { firstLine, newSnippet } from '$lib/snippets';

	// 設定は画面が出る前に読み終わっている（src/hooks.client.ts）が、届く前に描かれても既定で表示できるようにする
	const fontFamily = $derived(draftFontFamily(settings.current?.textFontFamily ?? ''));
	const fontSize = $derived(settings.current?.textFontSize ?? DEFAULT_DRAFT_FONT_SIZE);
	// 入力欄の案内。プレースホルダーは原則使わないが、使い方を伝える場所がほかにないので、ここだけ意図して置く
	const guidance = $derived(
		settings.current
			? draftGuidance(
					settings.current.inputGuidance,
					guidanceHotkey(settings.current),
					settings.current.textWindowKeys,
					settings.current.platform,
					settings.current.hotkeyUnavailable
				)
			: ''
	);

	// ボタンの説明に添える、操作のキーと、その表し方を決める OS。設定が届く前は undefined
	const keys = $derived(settings.current?.textWindowKeys);
	const platform = $derived(settings.current?.platform);

	// 入力欄の上下に操作のボタンを出すか
	const showButtons = $derived(settings.current?.showTextWindowButtons ?? true);

	let text = $state('');
	// IME（日本語入力）の変換中か。変換確定前は置き換え辞書のプレビューを求めない
	let composing = $state(false);
	const replacementPreview = new ReplacementPreview((text) =>
		invoke<ReplacementMatch[]>('preview_replacement_matches', { text })
	);
	const previewSegmentsList = $derived(previewSegments(text, replacementPreview.matches));
	// 入力欄のスクロール位置。裏のハイライト表示を同じ位置までずらして重ねる
	let scrollTop = $state(0);
	let scrollLeft = $state(0);
	function syncPreviewScroll() {
		if (!textarea) return;
		scrollTop = textarea.scrollTop;
		scrollLeft = textarea.scrollLeft;
	}
	// 入力欄のスクロールバーの幅。スクロールバーは入力欄にだけ出るので、裏のハイライトの幅をその分だけ狭めて折り返しを揃える
	let scrollbarWidth = $state(0);
	function measureScrollbar() {
		if (!textarea) return;
		const style = getComputedStyle(textarea);
		const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
		scrollbarWidth = Math.max(0, textarea.offsetWidth - textarea.clientWidth - borders);
	}
	$effect(() => {
		// 本文・文字の大きさ・フォントが変わると、スクロールバーが出たり消えたりする
		void [text, fontSize, fontFamily];
		measureScrollbar();
	});
	$effect(() => {
		if (!textarea) return;
		const observer = new ResizeObserver(measureScrollbar);
		observer.observe(textarea);
		return () => observer.disconnect();
	});
	// previewSegmentsList と同じ添字。ハイライトの範囲だけ埋まる（ホバー判定に使う）
	let markElements: (HTMLElement | undefined)[] = $state([]);
	/** x と y はマウスの位置、top と bottom はマウスが乗ったハイライトの行の上下 */
	let hoveredMatch = $state<{
		to: string;
		x: number;
		y: number;
		top: number;
		bottom: number;
	} | null>(null);
	let tooltip = $state<HTMLElement | null>(null);
	let tooltipPosition = $state({ left: 0, top: 0 });
	/**
	 * ツールチップはハイライトの上に出し、上に余地がなければ下に出す。左右は窓に収める。
	 * 大きさは出してみないと分からないので、描いた後に測って置き直す
	 */
	$effect(() => {
		if (!hoveredMatch || !tooltip) return;
		const { width, height } = tooltip.getBoundingClientRect();
		const margin = 4;
		const above = hoveredMatch.top - margin - height;
		// 下に出すときは、マウスのカーソルに隠れないよう少し離す
		const below = Math.max(hoveredMatch.bottom, hoveredMatch.y + 16) + margin;
		// 上下どちらにも入りきらないときも、窓の中に収める（大きさの上限は class で窓より小さくしてある）
		tooltipPosition = {
			left: clamp(hoveredMatch.x - width / 2, margin, window.innerWidth - margin - width),
			top: above >= margin ? above : clamp(below, margin, window.innerHeight - margin - height)
		};
	});
	/**
	 * ハイライト部分にマウスが乗ったら、置き換えた後の文字列をツールチップで見せる。
	 * <mark> はオーバーレイ側にあり pointer-events: none なので、座標を自前で比べる。
	 * 折り返しで複数行にまたがる場合を考えて、要素ごとの矩形は getClientRects() で行ごとに取る
	 */
	function onDraftMouseMove(event: MouseEvent) {
		const { clientX, clientY } = event;
		for (let index = 0; index < previewSegmentsList.length; index++) {
			const segment = previewSegmentsList[index];
			if (!segment.highlighted) continue;
			const element = markElements[index];
			if (!element) continue;
			for (const rect of element.getClientRects()) {
				if (
					clientX >= rect.left &&
					clientX <= rect.right &&
					clientY >= rect.top &&
					clientY <= rect.bottom
				) {
					hoveredMatch = {
						to: segment.to,
						x: clientX,
						y: clientY,
						top: rect.top,
						bottom: rect.bottom
					};
					return;
				}
			}
		}
		hoveredMatch = null;
	}
	$effect(() => {
		replacementPreview.update(text, composing);
		// 本文が変わったら、マウスが動かないまま古いツールチップだけが残らないよう消す
		hoveredMatch = null;
	});
	let error = $state('');
	// エラーの帯の見出し。何に失敗したかで分ける
	let errorTitle = $state('');
	function showError(title: string, message: string) {
		errorTitle = title;
		error = message;
	}
	let textarea = $state<HTMLTextAreaElement | null>(null);
	/** 画面の描き直し（一覧が閉じる）を待ってから、入力欄にフォーカスを移す */
	async function focusDraft() {
		await tick();
		textarea?.focus();
	}
	// 隠す操作（コピーする・しない）の完了待ち。重ねて受け付けると、Esc の直後の Cmd+Enter でコピーしてしまう
	let hiding = false;
	// 変換中に隠すと、隠した後に確定イベントが届いて文字が入力欄に戻ることがあるので、次の表示時にも空にする
	let clearOnShow = false;
	// commit の完了を待つ間に再表示されたかを見分けるため、表示の回数を数える
	let shownCount = 0;
	// コピーした下書きの履歴。本文はディスクにも保存する
	const draftHistory = new DraftHistory();
	let historyStarted = false;
	let historyReady = false;
	let historySavePending = false;
	// 「履歴を削除する」の回数。読み込みの最中に消されたら、その読み込みの結果は捨てる
	let historyClearedCount = 0;
	// 読み込み・読み直しの最中に、ほかのデバイスの履歴を混ぜて履歴が替わった知らせが届いた。終わってから読み直す
	let historyReloadPending = false;

	// 保存を待つ間に履歴が変わる（消される）ことがあるので、送る直前の中身を読む
	const saveHistory = coalescedSaver(async () => {
		// 順番を待つ間に読み直しが始まった。読み直す前の一覧は送らず、読み直した後に保存する
		if (draftHistory.isReloading) {
			historySavePending = true;
			return;
		}
		await invoke('save_draft_history', { entries: draftHistory.entries }).catch(() => {});
	});

	function saveDraftHistory() {
		if (!historyReady || draftHistory.isReloading) {
			historySavePending = true;
			return;
		}
		saveHistory();
	}

	function savePendingDraftHistory() {
		if (!historySavePending) return;
		historySavePending = false;
		saveDraftHistory();
	}

	/**
	 * ほかのデバイスの履歴を混ぜて履歴が替わったので、読み直す。読み直す前の一覧を保存すると、届いた履歴を古い一覧で上書きするので、
	 * 読み直している間は保存を待たせ、その間に覚えた履歴を、読み直した履歴の後ろに足してから保存する
	 */
	function reloadDraftHistory() {
		if (!historyReady || draftHistory.isReloading) {
			historyReloadPending = true;
			return;
		}
		draftHistory.beginReload();
		const clearedCountAtStart = historyClearedCount;
		invoke<string[]>('load_draft_history')
			.then((loaded) => {
				const entries = clearedCountAtStart === historyClearedCount ? (loaded ?? []) : [];
				if (draftHistory.finishReload(entries)) historySavePending = true;
			})
			.catch(() => draftHistory.cancelReload())
			.finally(() => {
				savePendingDraftHistory();
				if (!historyReloadPending) return;
				historyReloadPending = false;
				reloadDraftHistory();
			});
	}

	/** 初めの読み込みが済んだ。待たせていた保存と読み直しを流す */
	function onDraftHistoryReady() {
		historyReady = true;
		savePendingDraftHistory();
		if (!historyReloadPending) return;
		historyReloadPending = false;
		reloadDraftHistory();
	}

	$effect(() => {
		const size = settings.current?.textHistorySize ?? DEFAULT_DRAFT_HISTORY_SIZE;
		const resized = draftHistory.resize(size);
		if (historyReady && resized) saveDraftHistory();
		if (historyStarted || !settings.current) return;
		historyStarted = true;
		if (size === 0) {
			invoke('clear_draft_history').catch(() => {});
			historyReady = true;
			historySavePending = false;
			return;
		}
		const clearedCountAtStart = historyClearedCount;
		invoke<string[]>('load_draft_history')
			.then((loaded) => {
				const entries = clearedCountAtStart === historyClearedCount ? loaded : [];
				draftHistory.load(entries ?? []);
				// 読み込み前に record された履歴を、読み込んだ履歴と合わせて保存し直す
				if ((entries?.length ?? 0) > 0) historySavePending = true;
				onDraftHistoryReady();
			})
			.catch(onDraftHistoryReady);
	});

	// 定型文の一覧を出したときの入力欄のカーソルと選択範囲。差し込む先・書き直す範囲で、閉じたときにも戻す。
	// 一覧は一度に1つしか出さないので、1つだけ持つ
	let selectionBeforeList = { start: 0, end: 0 };

	/**
	 * 一覧を出す前に、入力欄のカーソルと選択範囲を覚える。入力欄がなければ false。
	 * ボタンで出すときも、押してフォーカスが移っても入力欄の選択範囲は残るので、押す前の範囲を覚えられる
	 */
	function rememberSelection(): boolean {
		if (!textarea) return false;
		selectionBeforeList = { start: textarea.selectionStart, end: textarea.selectionEnd };
		return true;
	}

	/** 一覧を閉じた後、入力欄に戻り、カーソルと選択範囲を出したときのまま戻す。戻した入力欄を返す */
	async function restoreSelection(): Promise<HTMLTextAreaElement | null> {
		await tick();
		if (!textarea) return null;
		textarea.focus();
		textarea.setSelectionRange(selectionBeforeList.start, selectionBeforeList.end);
		return textarea;
	}

	/** 一覧を出したときに選んでいた範囲。選んでいなければ入力欄の中身全体（定型文に登録する文） */
	function listTarget() {
		const { start, end } = selectionBeforeList;
		const selected = start !== end;
		return { text: selected ? text.slice(start, end) : text, selected };
	}

	// 定型文の一覧を出しているか
	let snippetsOpen = $state(false);
	// 履歴の検索の一覧を出しているか。一覧は一度に1つしか出さない
	let historySearchOpen = $state(false);

	function openSnippets(): boolean {
		if (!rememberSelection()) return false;
		snippetsOpen = true;
		return true;
	}

	async function closeSnippets(): Promise<HTMLTextAreaElement | null> {
		snippetsOpen = false;
		return restoreSelection();
	}

	function openHistorySearch(): boolean {
		if (!rememberSelection()) return false;
		historySearchOpen = true;
		return true;
	}

	async function closeHistorySearch(): Promise<HTMLTextAreaElement | null> {
		historySearchOpen = false;
		return restoreSelection();
	}

	/** 検索の一覧で選んだ履歴を、上キーで出したときと同じく入力欄の中身と入れ替える */
	async function pickHistory(item: HistoryItem) {
		// 一覧を閉じるのを待つ間に、ほかのデバイスの履歴を読み直して位置が替わらないよう、先に移る
		const entry = draftHistory.jump(item.index, text);
		const element = await closeHistorySearch();
		if (element && entry !== null) showHistoryEntry(entry, 'older', element);
	}

	/** 一覧を出したときのカーソルの位置に差し込む。範囲を選んでいたら置き換え、カーソルは差し込んだ文の末尾に置く */
	async function insertSnippet(body: string) {
		const element = await closeSnippets();
		if (!element) return;
		// input イベントも起きるので、履歴をたどっている途中なら、書き換えたときと同じくそこでやめる
		insertAsTyped(element, body, selectionBeforeList.start, selectionBeforeList.end);
	}

	/**
	 * 定型文の一覧の末尾に添える、下書き（選んだ範囲）を定型文に登録する項目。絞り込みに打った文字があれば名前にする。
	 * 登録するものがなければ出さない
	 */
	function registerSnippetAction(query: string): PaletteAction | null {
		const target = listTarget();
		if (target.text.trim() === '') return null;
		const name = query.trim();
		return {
			label: target.selected
				? name
					? m.snippets_register_selection_named({ name })
					: m.snippets_register_selection()
				: name
					? m.snippets_register_draft_named({ name })
					: m.snippets_register_draft(),
			preview: firstLine(target.text),
			icon: BookmarkPlusIcon,
			run: () => registerSnippet(name, target.text)
		};
	}

	/** 定型文に登録して一覧を閉じる。下書きとカーソルは一覧を出したときのまま。同じ本文があれば足さない */
	async function registerSnippet(name: string, body: string) {
		await closeSnippets();
		try {
			const added = await invoke<boolean>('add_snippet', {
				snippet: newSnippet(name, body)
			});
			showNotice(added ? m.draft_snippet_registered() : m.draft_snippet_already_registered());
		} catch (e) {
			showError(m.draft_snippet_register_failed(), settingsSaveProblem(e) ?? errorCode(e));
		}
	}

	// 下書きの下に少しの間だけ出す知らせ（定型文に登録した、など）
	let notice = $state('');
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	const NOTICE_MS = 3000;

	function showNotice(message: string) {
		clearTimeout(noticeTimer);
		notice = message;
		noticeTimer = setTimeout(() => (notice = ''), NOTICE_MS);
	}

	// 知らせとエラーは出した時点の文言で持つので、表示言語が変わったら消す。前の言語のまま残さない
	let shownLocale: string | undefined;
	$effect(() => {
		const locale = settings.locale;
		if (shownLocale !== undefined && shownLocale !== locale) {
			clearTimeout(noticeTimer);
			notice = '';
			error = '';
		}
		shownLocale = locale;
	});

	// 一覧に出す定型文。切った定型文は出さない
	const listedSnippets = $derived(
		(settings.current?.snippets ?? []).filter((snippet) => snippet.enabled)
	);

	/** 一覧で選んだ定型文を、カーソルの位置に挿入する */
	function pickSnippet(snippet: Snippet) {
		return insertSnippet(snippet.body);
	}

	/** コピーして隠す。隠すのは Rust 側で、渡したら true、空で何もしなかったら false が返る */
	async function commit() {
		if (hiding) return;
		hiding = true;
		const shownAtCommit = shownCount;
		// 完了を待つ間に打ち直されうるので、コピーに渡した内容を履歴に覚える
		const committed = text;
		// ネイティブ側は invoke の中でウィンドウを隠すので、完了を待つ前にホットキーで再表示されうる。先に空にする予約をしておく
		clearOnShow = true;
		try {
			// 整えた結果が空でクリップボードを変えなかったときは false が返り、履歴にも覚えない
			const copied = await invoke<boolean>('commit', { text: committed });
			// クリップボードを変えたかどうかに関わらず、隠したので履歴をたどっていた状態は終える
			draftHistory.stopBrowsing();
			if (copied && draftHistory.record(committed)) saveDraftHistory();
			// コピーの完了を待つ間に再表示されていたら、そこで空にしてから打ち直した内容なので消さない
			if (shownCount === shownAtCommit && text === committed) text = '';
			error = '';
		} catch (e) {
			showError(m.copy_failed(), errorCode(e));
			// 隠れずに残るので、コピーのボタンで押したときも、そのまま書き続けてキーを使えるよう入力欄に戻す
			textarea?.focus();
		} finally {
			// 終わったら予約は要らない。残すと、後で書いた下書きを次に出したときに消してしまう
			clearOnShow = false;
			hiding = false;
		}
	}

	async function onShown() {
		shownCount++;
		// 一覧を出したまま隠れていたら、出し直したときは入力欄から始める
		snippetsOpen = false;
		historySearchOpen = false;
		// 前に出していたときの知らせは、出し直したら要らない
		notice = '';
		// 変換中に隠れて compositionend が届かなかった場合に備え、出し直すたびに変換中の扱いを解く
		composing = false;
		if (clearOnShow) {
			text = '';
			clearOnShow = false;
		}
		await focusDraft();
	}

	// コピーせずに隠す。書きかけは入力欄に残し、次に出したときに続きを書けるようにする
	async function dismiss() {
		if (hiding) return;
		hiding = true;
		try {
			await invoke('dismiss');
		} catch {
			// 失敗は Rust 側でログに残す。隠れなければ、そのまま書き続けられる
		} finally {
			hiding = false;
		}
	}

	function onKeydown(event: KeyboardEvent) {
		const view = settings.current;
		const action = view ? draftActionFor(event, view.textWindowKeys, view.platform) : null;
		if (isDismissKey(event)) {
			event.preventDefault();
			dismiss();
			return;
		}
		// 今は使えない操作のキーも、既定の動作を止めて何もしない。入力欄の編集キーは割り当てられないので入力欄で起きることはなく、
		// 渡すと WebView の既定のキー（WebView2 の Ctrl+J のダウンロードの一覧など）が動いて、下書きからフォーカスが外れるため
		if (action) {
			event.preventDefault();
			runAction(action);
			return;
		}
		// Tab は入力欄の中でタブ文字にする。既定のままだと入力欄の外へフォーカスが移り、打てなくなる
		if (isTabKey(event) && event.target === textarea && textarea) {
			event.preventDefault();
			insertAsTyped(textarea, '\t');
			return;
		}
		const direction = historyDirection(event);
		if (direction && textarea) recallHistory(event, direction, textarea);
	}

	/**
	 * WebView のブラウザーとしてのキー。読み込み直す（F5・Ctrl+R）と書きかけが消え、
	 * 印刷（Ctrl+P）・ページ内検索（Ctrl+F・Ctrl+G・F3）・キャレットブラウズ（F7）は、窓やバーを出して入力欄からフォーカスを奪う。
	 * Shift や Ctrl を足したものも同じ。読み込み直す以外は WebView2 のキーで、macOS では Ctrl+F・Ctrl+P が入力欄のカーソル移動なので Windows だけ止める
	 */
	function isBrowserKey(event: KeyboardEvent): boolean {
		if (event.altKey || event.metaKey) return false;
		if (event.key === 'F5' || (event.ctrlKey && event.code === 'KeyR')) return true;
		if (settings.current?.platform !== 'windows') return false;
		if (['F3', 'F7'].includes(event.key)) return true;
		return event.ctrlKey && ['KeyP', 'KeyF', 'KeyG'].includes(event.code);
	}

	// 打っている最中に余白などを押しても、入力欄からフォーカスを外さない（draft-focus.ts）
	function onWindowMousedown(event: MouseEvent) {
		if (
			event.button === 0 &&
			document.activeElement === textarea &&
			keepsDraftFocus(event.target)
		) {
			event.preventDefault();
		}
	}

	/**
	 * 入力欄の外で押したキー。入力欄と一覧は自分で受けるので、そこで止めなかったものだけがここへ届く。
	 * 一覧を開いている間は、下書きの操作のキーを止めるだけにする（一覧は修飾キー付きのキーを使わず、
	 * 止めないと WebView2 の Ctrl+J のダウンロードの一覧や macOS のメニューのキーに届く）。
	 * どちらも開いていなければ、ボタンを押してフォーカスが入力欄から外れたので、入力欄と同じく Esc と操作のキーを効かせる
	 */
	function onWindowKeydown(event: KeyboardEvent) {
		const handled = event.defaultPrevented;
		// WebView2 のブラウザーとしてのキー（F5 で読み込み直す・Ctrl+P で印刷する など）は、どこにフォーカスがあっても既定の動作を止める。
		// 操作に割り当てたキーなら、止めたうえで下で操作を呼ぶ
		if (isBrowserKey(event)) event.preventDefault();
		if (handled || event.target === textarea) return;
		const view = settings.current;
		const action = view ? draftActionFor(event, view.textWindowKeys, view.platform) : null;
		if (snippetsOpen || historySearchOpen) {
			if (action) event.preventDefault();
			return;
		}
		// ボタンにフォーカスがあるときの Enter や Space は、ボタンの操作なので横取りしない
		if (!action && !isDismissKey(event)) return;
		onKeydown(event);
	}

	/** キーに割り当てた操作を呼ぶ。今は使えない操作なら何もせず false を返す */
	function runAction(action: DraftAction): boolean {
		switch (action) {
			case 'copy':
				commit();
				return true;
			case 'settings':
				// 設定を開く間、下書きは Rust 側で隠れる。コピーはしないので書きかけは残り、設定を閉じると出し直される。
				// 設定がすでにあれば、キーだけはトグルとして閉じる。
				invoke('toggle_settings_window');
				return true;
			case 'snippets':
				return openSnippets();
			case 'historyOlder':
			case 'historyNewer':
				stepHistory(action === 'historyOlder' ? 'older' : 'newer');
				return true;
			case 'historySearch':
				return openHistorySearch();
		}
	}

	/**
	 * 入力欄の先頭の上キーで古い履歴を、末尾の下キーで新しい履歴を出す。
	 * 先頭・末尾ではない見た目の1行目・最終行では、まずその端へカーソルを移す。
	 * 行は見た目で数え、折り返した行も1行とする
	 */
	function recallHistory(
		event: KeyboardEvent,
		direction: HistoryDirection,
		element: HTMLTextAreaElement
	) {
		// 移る先がなければ、行を測らずに普段どおりカーソルを動かす
		if (direction === 'older' ? !draftHistory.canGoOlder : !draftHistory.canGoNewer) return;
		const line = caretLine(element);
		let entry: string | null = null;
		if (direction === 'older' && line?.first && element.selectionStart === 0) {
			entry = draftHistory.older(text);
		} else if (direction === 'newer' && line?.last && element.selectionStart === text.length) {
			entry = draftHistory.newer();
		} else if (direction === 'older' && line?.first) {
			event.preventDefault();
			element.setSelectionRange(0, 0);
			return;
		} else if (direction === 'newer' && line?.last) {
			event.preventDefault();
			element.setSelectionRange(text.length, text.length);
			return;
		}
		// 先がなければ、普段どおりカーソルを動かす
		if (entry === null) return;
		event.preventDefault();
		showHistoryEntry(entry, direction, element);
	}

	/** 前・次のボタンと、前の履歴・次の履歴のキー。↑↓ と違い、カーソルの行にかかわらず移る。移った後は入力欄にフォーカスを戻す */
	function stepHistory(direction: HistoryDirection) {
		if (!textarea) return;
		const entry = direction === 'older' ? draftHistory.older(text) : draftHistory.newer();
		textarea.focus();
		if (entry !== null) showHistoryEntry(entry, direction, textarea);
	}

	/** 履歴の1件を入力欄に出す */
	function showHistoryEntry(
		entry: string,
		direction: HistoryDirection,
		element: HTMLTextAreaElement
	) {
		text = entry;
		// 同じキーを続けて押せば次の履歴へ移れるよう、古い方では先頭、新しい方では末尾に置く。入力欄に中身が入ってから置く
		const caret = direction === 'older' ? 0 : entry.length;
		tick().then(() => element.setSelectionRange(caret, caret));
	}

	onMount(() => {
		const unlisten = Promise.all([
			listen(EVENTS.SHOWN, onShown),
			listen(EVENTS.HIDE_REQUESTED, commit),
			listen(EVENTS.DRAFT_HISTORY_CLEARED, () => {
				historyClearedCount += 1;
				draftHistory.clear();
				historySavePending = false;
			}),
			listen(EVENTS.DRAFT_HISTORY_MERGED, reloadDraftHistory)
		]).then((fns) => {
			// 読み込みが終わる前に表示されると shown を取り逃がすので、表示中かを Rust 側に確かめる。
			// 表示中なら Rust 側が WebView にキーボードのフォーカスを移すので、ここでは表示時の処理をする
			invoke<boolean>('page_ready').then((active) => {
				if (active) onShown();
			});
			return fns;
		});
		return () => {
			unlisten.then((fns) => fns.forEach((fn) => fn()));
		};
	});
</script>

<!-- 文字色はテーマごとに変数で渡し、下の style で .dark かどうかに合わせて選ぶ。空なら変数を当てず、標準の文字色に任せる -->
<svelte:window onkeydown={onWindowKeydown} onmousedown={onWindowMousedown} />

<main
	class="relative flex h-screen flex-col gap-2 p-2"
	style:--draft-text-light={settings.current?.textColorLight || undefined}
	style:--draft-text-dark={settings.current?.textColorDark || undefined}
>
	<!--
		ボタンはマウスで使うもので、Tab では移らない（tabindex="-1"）。下書きのキーは入力欄で受けているので、
		フォーカスがボタンに移ると Esc や Cmd+Enter が効かなくなる
	-->
	<!--
		上の並び。履歴の前・次を左にまとめ、道具を右に寄せる（ブラウザや Finder のツールバーと同じ並び）。設定は、ツールバーの慣れた位置の右端に置く。
		前・次・履歴の検索は、覚えている履歴がなければ使えないので出さない。
		列が狭いとき（最小の幅の近く）は、定型文をアイコンだけにする
	-->
	{#if showButtons && keys && platform}
		<div class="@container flex items-center gap-1">
			{#if draftHistory.hasEntries}
				<Button
					tabindex={-1}
					variant="ghost"
					size="sm"
					disabled={!draftHistory.canGoOlder}
					title={keys.historyOlder
						? m.draft_history_older_hint_key({ keys: formatKeys(keys.historyOlder, platform) })
						: m.draft_history_older_hint()}
					onclick={() => stepHistory('older')}
				>
					<ChevronLeftIcon data-icon="inline-start" />
					{m.draft_history_older()}
				</Button>
				<Button
					tabindex={-1}
					variant="ghost"
					size="sm"
					disabled={!draftHistory.canGoNewer}
					title={keys.historyNewer
						? m.draft_history_newer_hint_key({ keys: formatKeys(keys.historyNewer, platform) })
						: m.draft_history_newer_hint()}
					onclick={() => stepHistory('newer')}
				>
					{m.draft_history_newer()}
					<ChevronRightIcon data-icon="inline-end" />
				</Button>
				<Button
					tabindex={-1}
					variant="ghost"
					size="icon-sm"
					aria-label={m.draft_history_search()}
					title={keyHint(m.draft_history_search(), keys.historySearch, platform)}
					onclick={openHistorySearch}
				>
					<SearchIcon />
				</Button>
			{/if}
			<div class="ml-auto flex items-center gap-1">
				<Button
					tabindex={-1}
					variant="ghost"
					size="sm"
					title={keyHint(m.draft_snippets_hint(), keys.snippets, platform)}
					onclick={openSnippets}
				>
					<TextQuoteIcon data-icon="inline-start" />
					<span class="@max-[30rem]:sr-only">{m.draft_snippets()}</span>
				</Button>
				<Button
					tabindex={-1}
					variant="ghost"
					size="icon-sm"
					aria-label={m.draft_settings()}
					title={keyHint(m.draft_settings_hint(), keys.settings, platform)}
					onclick={() => invoke('open_settings_window')}
				>
					<SettingsIcon />
				</Button>
			</div>
		</div>
	{/if}
	<!--
		大きさを class ではなく style で当てる。部品の既定クラスは text-base md:text-sm で、
		ウィンドウ幅が 768px を超えると縮む。画面幅ではなくウィンドウ幅で切り替わるため、広げたのに縮んでしまう
	-->
	<!-- isolate で下の z-0・z-10 をこの中だけに閉じ込める。外に漏れると、後から出す一覧より入力欄が手前に描かれる -->
	<div class="relative isolate min-h-0 flex-1">
		<!--
			コピー時に置き換え辞書で書き換わる範囲を、裏に重ねた透明な div でハイライトする。
			文字色を透明にし、一致箇所だけ背景色を付ける。padding・border・フォント・折り返しを textarea と揃え、
			スクロール位置も同期させることで、実際の文字の裏にちょうど重なる。ここ自体は入力を受けない（pointer-events-none）。
			入力欄の案内もここに出す。placeholder は、WebKitGTK が入力欄より広い幅で折り返し、右端が見切れるため。
			placeholder の属性は読み上げのために残し、文字だけを透明にする
		-->
		<div
			class="pointer-events-none absolute inset-y-0 left-0 z-0 overflow-hidden rounded-lg border border-transparent px-2.5 py-2 text-base md:text-sm [&_*]:[word-break:inherit]"
			style="right: {scrollbarWidth}px; font-family: {fontFamily}; font-size: {fontSize}px; line-height: 1.5; color: transparent; white-space: pre-wrap; word-break: break-word;"
			aria-hidden="true"
		>
			<div style="transform: translate({-scrollLeft}px, {-scrollTop}px);">
				{#if text === '' && guidance}<span class="draft-guidance">{guidance}</span>{/if}
				{#each previewSegmentsList as segment, index (index)}{#if segment.highlighted}<mark
							bind:this={markElements[index]}
							class="rounded-[0.1em] bg-yellow-300/60 text-transparent dark:bg-yellow-400/40"
							>{segment.text}</mark
						>{:else}{segment.text}{/if}{/each}
			</div>
		</div>
		<Textarea
			bind:ref={textarea}
			bind:value={text}
			class="relative z-10 field-sizing-fixed h-full min-h-0 resize-none bg-transparent dark:bg-transparent"
			style="font-family: {fontFamily}; font-size: {fontSize}px; line-height: 1.5"
			spellcheck="false"
			placeholder={guidance || undefined}
			aria-label={m.draft_label()}
			onkeydown={onKeydown}
			oninput={() => draftHistory.stopBrowsing()}
			onscroll={syncPreviewScroll}
			onmousemove={onDraftMouseMove}
			onmouseleave={() => (hoveredMatch = null)}
			oncompositionstart={() => (composing = true)}
			oncompositionend={() => (composing = false)}
		/>
		{#if hoveredMatch}
			<!-- ハイライトの上（余地がなければ下）に置き換え後の文字列を出す。マウスの動きを邪魔しないよう、こちらも pointer-events-none -->
			<div
				bind:this={tooltip}
				class="pointer-events-none fixed z-20 max-h-[calc(100vh-0.5rem)] w-max max-w-[calc(100vw-0.5rem)] overflow-hidden rounded-md border bg-popover px-2 py-1 text-xs break-words whitespace-pre-wrap text-popover-foreground shadow-md"
				style="left: {tooltipPosition.left}px; top: {tooltipPosition.top}px;"
			>
				{hoveredMatch.to || m.draft_replacement_preview_removed()}
			</div>
		{/if}
	</div>
	{#if notice}
		<p role="status" class="flex items-center gap-2 px-1 text-sm text-muted-foreground">
			<CircleCheckIcon class="size-4 shrink-0" aria-hidden="true" />
			<span class="truncate">{notice}</span>
		</p>
	{/if}
	{#if showButtons && keys && platform}
		<!--
			下の並び。右にコピー。キーを添えるのはこのボタンだけで、
			ほかは狭い窓に文字を詰め込まないよう、マウスを重ねたときの説明に出す（英語でコピーのキーが3つだと、はみ出していた）
		-->
		<div class="@container flex items-center gap-1">
			<!-- 変換中に押すと、入力欄からフォーカスが外れて未確定の文字が確定し、その内容でコピーする -->
			<Button tabindex={-1} size="sm" class="ml-auto" onclick={commit}>
				{m.draft_copy()}
				{#if keys.copy}
					<KeyCaps key={keys.copy} {platform} />
				{/if}
			</Button>
		</div>
	{/if}
	{#if error}
		<Alert.Root variant="destructive">
			<CircleAlertIcon />
			<Alert.Title>{errorTitle}</Alert.Title>
			<Alert.Description class="whitespace-pre-line">{error}</Alert.Description>
		</Alert.Root>
	{/if}
	{#if snippetsOpen && settings.current}
		<!-- 一覧を出している間は、フォーカスが一覧にあるので、入力欄のキー（Cmd+Enter など）は効かない -->
		<TextPalette
			items={listedSnippets}
			platform={settings.current.platform}
			toggleKey={settings.current.textWindowKeys.snippets}
			listLabel={m.snippets_list()}
			searchLabel={m.snippets_search()}
			emptyMessage={settings.current.textWindowKeys.settings
				? m.snippets_empty({
						settings: formatKeys(
							settings.current.textWindowKeys.settings,
							settings.current.platform
						)
					})
				: m.snippets_empty_no_key()}
			noMatchMessage={m.snippets_no_match()}
			action={registerSnippetAction}
			onpick={pickSnippet}
			onclose={closeSnippets}
		/>
	{/if}
	{#if historySearchOpen && settings.current}
		<TextPalette
			items={draftHistory.searchItems}
			platform={settings.current.platform}
			toggleKey={settings.current.textWindowKeys.historySearch}
			listLabel={m.history_list()}
			searchLabel={m.history_search()}
			emptyMessage={m.history_empty()}
			noMatchMessage={m.history_no_match()}
			preview={(item, query) => historyPreview(item.body, query)}
			onpick={pickHistory}
			onclose={closeHistorySearch}
		/>
	{/if}
</main>

<style>
	/*
		テーマは mode-watcher が付ける .dark で見る。prefers-color-scheme で分けると、テーマを固定したときに
		WebView 側が OS の設定のままで、食い違うことがある（wry#806）
	*/
	main :global(textarea) {
		color: var(--draft-text-light, var(--foreground));
	}
	:global(.dark) main :global(textarea) {
		color: var(--draft-text-dark, var(--foreground));
	}
	/* 透明にした placeholder も、WebKitGTK では入力欄の幅をはみ出して横のスクロールバーを出す。入力した文字は折り返すので、横にはスクロールさせない */
	main :global(textarea) {
		overflow-x: hidden;
	}
	main :global(textarea::placeholder) {
		color: transparent;
	}
	/* 案内は、入力した文字と見間違えないよう、緑みの薄い色の斜体にする */
	.draft-guidance {
		color: var(--draft-guidance);
		font-style: italic;
	}
</style>
