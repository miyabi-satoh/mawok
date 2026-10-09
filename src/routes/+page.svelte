<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import BookmarkPlusIcon from '@lucide/svelte/icons/bookmark-plus';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import SendIcon from '@lucide/svelte/icons/send';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import TextQuoteIcon from '@lucide/svelte/icons/text-quote';
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import { onMount, tick } from 'svelte';
	import FolderPalette from '$lib/components/folder-palette.svelte';
	import SendTargetPalette from '$lib/components/send-target-palette.svelte';
	import TextPalette, { type PaletteAction } from '$lib/components/text-palette.svelte';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import * as Kbd from '$lib/components/ui/kbd';
	import { Textarea } from '$lib/components/ui/textarea';
	import { DEFAULT_DRAFT_FONT_SIZE, draftFontFamily } from '$lib/font';
	import { draftGuidance } from '$lib/guidance';
	import { deviceLabels, unbrokenAtHyphens } from '$lib/devices';
	import { errorCode } from '$lib/errors';
	import { insertAsTyped } from '$lib/insert-text';
	import { isPartialSend, lanErrorMessage } from '$lib/lan-errors';
	import {
		DEFAULT_DRAFT_HISTORY_SIZE,
		DraftHistory,
		historyDirection,
		type HistoryDirection
	} from '$lib/history.svelte';
	import { caretLine } from '$lib/caret-line';
	import { clamp } from '$lib/clamp';
	import {
		draftActionFor,
		formatKeys,
		isDismissKey,
		keyHint,
		keyLabels,
		type DraftAction
	} from '$lib/keys';
	import { m } from '$lib/paraglide/messages';
	import { EVENTS } from '$lib/bindings/constants';
	import type { ReceivedDraft } from '$lib/bindings/ReceivedDraft';
	import type { FolderCompletion } from '$lib/bindings/FolderCompletion';
	import { coalescedSaver } from '$lib/saver';
	import { folderErrorMessage } from '$lib/folder-errors';
	import {
		previewSegments,
		ReplacementPreview,
		type ReplacementMatch
	} from '$lib/replacement-preview.svelte';
	import { actionErrorMessage } from '$lib/action-errors';
	import { aiInstruction, isRunnable, newAction, splitActionTarget } from '$lib/action-target';
	import { settings, type Action, type ActionOutput } from '$lib/settings.svelte';
	import { firstLine, snippetLabel } from '$lib/snippets';

	// 設定は画面が出る前に読み終わっている（src/hooks.client.ts）が、届く前に描かれても既定で表示できるようにする
	const fontFamily = $derived(draftFontFamily(settings.current?.textFontFamily ?? ''));
	const fontSize = $derived(settings.current?.textFontSize ?? DEFAULT_DRAFT_FONT_SIZE);
	// 入力欄の案内。プレースホルダーは原則使わないが、使い方を伝える場所がほかにないので、ここだけ意図して置く
	const guidance = $derived(
		settings.current
			? draftGuidance(
					settings.current.inputGuidance,
					settings.current.hotkey,
					settings.current.textWindowKeys,
					settings.current.platform
				)
			: ''
	);

	// 入力欄の上下に操作のボタンを出すか
	const showButtons = $derived(settings.current?.showTextWindowButtons ?? true);

	// 組み合わせた機器があるときだけ、送るキーとボタンを使える（docs/lan.md「同じ LAN の自分の機器へ送る」）
	const pairedDevices = $derived(settings.current?.pairedDevices ?? []);
	const hasPairedDevice = $derived(pairedDevices.length > 0);
	const deviceNames = $derived(deviceLabels(pairedDevices));
	// 送り先の一覧を出しているか
	let targetsOpen = $state(false);

	let text = $state('');
	// 書きかけがあるかを Rust 側に知らせる。Mac 版の更新で再起動する前に、消えることを設定の画面で伝えるため。
	// 空かどうかが変わったときだけ知らせ、中身は渡さない
	const hasText = $derived(text.trim() !== '');
	const isMac = $derived(settings.current?.platform === 'macos');
	$effect(() => {
		if (isMac) invoke('set_draft_has_text', { hasText }).catch(() => {});
	});
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
	// エラーの帯の見出し。コピーと送るで分ける
	let errorTitle = $state('');
	// 残高が尽きたときだけ、料金ページを開く操作を帯に添える。帯の文から決めるので、ほかの失敗で文が変わればボタンも消える
	const noCredit = $derived(error === m.action_error_no_credit());
	// 組み合わせた機器へ送っている最中か。つないで送り終えるまで数秒かかることがあり、その間は書き換えさせない
	let sending = $state(false);
	let textarea = $state<HTMLTextAreaElement | null>(null);
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
	// 「履歴を消す」の回数。読み込みの最中に消されたら、その読み込みの結果は捨てる
	let historyClearedCount = 0;

	// 保存を待つ間に履歴が変わる（消される）ことがあるので、送る直前の中身を読む
	const saveHistory = coalescedSaver(() =>
		invoke('save_draft_history', { entries: draftHistory.entries }).catch(() => {})
	);

	function saveDraftHistory() {
		if (!historyReady) {
			historySavePending = true;
			return;
		}
		saveHistory();
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
				historyReady = true;
				// 読み込み前に record された履歴を、読み込んだ履歴と合わせて保存し直す
				if (historySavePending || (entries?.length ?? 0) > 0) {
					historySavePending = false;
					saveDraftHistory();
				}
			})
			.catch(() => {
				historyReady = true;
				if (historySavePending) {
					historySavePending = false;
					saveDraftHistory();
				}
			});
	});

	// 一覧（定型文・アクション）を出したときの入力欄のカーソルと選択範囲。差し込む先・書き直す範囲で、閉じたときにも戻す。
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

	/** 一覧を出したときに選んでいた範囲。選んでいなければ入力欄の中身全体（アクションで実行する文、定型文に登録する文） */
	function listTarget() {
		const { start, end } = selectionBeforeList;
		const [from, to] = start === end ? [0, text.length] : [start, end];
		return { start: from, end: to, text: text.slice(from, to), selected: start !== end };
	}

	// 定型文の一覧を出しているか
	let snippetsOpen = $state(false);

	function openSnippets(): boolean {
		if (!rememberSelection()) return false;
		snippetsOpen = true;
		return true;
	}

	async function closeSnippets(): Promise<HTMLTextAreaElement | null> {
		snippetsOpen = false;
		return restoreSelection();
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
			const added = await invoke<boolean>('add_snippet', { snippet: { name, body } });
			showNotice(added ? m.draft_snippet_registered() : m.draft_snippet_already_registered());
		} catch (e) {
			errorTitle = m.draft_snippet_register_failed();
			error = errorCode(e);
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

	// アクションの一覧に出すもの。コマンドの行を本文として、定型文の一覧と同じ部品で出し、見出しの下に行を添える。
	// 切ったアクションは出さない。AI が使えるかどうかでは絞らない（使えないときに `@ai` の行を実行したら、失敗の帯で知らせる）
	const actionItems = $derived(
		(settings.current?.actions ?? []).flatMap((action) => {
			if (!action.enabled || !isRunnable(action.command)) return [];
			return [{ name: action.name, body: action.command, action }];
		})
	);
	/**
	 * 一覧の先頭に添える、打った行をその場で実行する項目。登録したアクションと同じ規則で、`@ai` なら AI、それ以外はシェルで実行し、
	 * 結果で置き換える。実行するものがないので、空の行（`@ai` だけの行を含む）では出さない。
	 * AI が使えない状態で `@ai` の行を実行したら、Rust 側が action.disabled を返し、失敗の帯で知らせる
	 */
	function freeInputAction(query: string): PaletteAction | null {
		if (!isRunnable(query)) return null;
		// 固定の見出しではなく、打った内容そのものを状態の行に出す
		return {
			label: m.actions_free_input(),
			preview: query,
			run: () => executeAction(newAction('', query), query)
		};
	}
	// アクションの一覧を出しているか
	let actionsOpen = $state(false);
	// 作業フォルダーへ移る欄を出しているか
	let folderOpen = $state(false);
	// 欄を開いたときの作業フォルダーの見せる形（Rust 側の current_folder）。欄はこのパスを入れた状態で出す
	let folder = $state('');

	/** アクションを実行している最中の1回 */
	type RunningAction = {
		/** 状態の行に出すアクションの名前 */
		label: string;
		/** Rust 側が振った番号。受け取る前は null */
		request: number | null;
		/** 実行を始めたときの入力欄の中身全体。差し替える前の文として履歴に積む */
		original: string;
		/** 結果の出し方 */
		output: ActionOutput;
		/** 実行する範囲。範囲を選んでいなければ全体 */
		start: number;
		end: number;
		/** 差し込む位置。範囲を選んでいたらその後ろ、なければカーソルの位置 */
		caret: number;
	};
	// アクションを実行している最中の1回。していなければ null。
	// 取り消しや次の実行と、遅れて届いた結果を見分けるため、同じものかどうかをそのまま比べる（proxy にしない）
	let running = $state.raw<RunningAction | null>(null);
	// 下書きウィンドウが出ているか。画面の描き分けには使わないので、状態にしない。
	// 実行は出ているときにしか始められないので、読み込んだときは出ているものとしてよい
	let draftVisible = true;
	/** 隠れている間に届いたアクションの結果を差し替える関数。出し直したときに呼ぶ */
	let pendingResult: (() => Promise<void>) | null = null;

	function openActions(): boolean {
		if (!rememberSelection()) return false;
		actionsOpen = true;
		return true;
	}

	async function closeActions() {
		actionsOpen = false;
		await restoreSelection();
	}

	function openFolder(): boolean {
		if (!rememberSelection()) return false;
		// ホームフォルダーが取れないときは、欄を出さずに終える（Rust 側が理由をログに残す）
		void invoke<string>('current_folder')
			.then((current) => {
				folder = current;
				folderOpen = true;
			})
			.catch(() => {});
		return true;
	}

	/** 打ちかけのパスを補う。補えなければ（ホームフォルダーが取れないなど）null で、欄はそのまま */
	async function completeFolder(input: string): Promise<FolderCompletion | null> {
		return invoke<FolderCompletion>('complete_folder', { input }).catch(() => null);
	}

	async function closeFolder() {
		folderOpen = false;
		await restoreSelection();
	}

	/** 打ったパスへ作業フォルダーを移す。移れたら欄を閉じ、移れなければ欄の下に出す文言を返す */
	async function changeFolder(input: string): Promise<string | null> {
		try {
			await invoke('change_folder', { input });
		} catch (error) {
			return folderErrorMessage(error);
		}
		await closeFolder();
		return null;
	}

	/**
	 * 選んだアクションを実行する。一覧を出したときに範囲を選んでいればその範囲、なければ入力欄の中身全体を渡す（空でも実行する）。
	 * 届いたら結果の出し方に従って下書きに出し、差し替える前の中身全体を履歴に積む
	 */
	async function executeAction(action: Action, label: string) {
		await closeActions();
		const { start, end, text: target } = listTarget();
		// 前の失敗の知らせは、次の実行を始めたら消す
		error = '';
		const session: RunningAction = {
			label,
			request: null,
			original: text,
			output: action.output,
			start,
			end,
			caret: selectionBeforeList.end
		};
		running = session;
		const parts = splitActionTarget(target, aiInstruction(action.command) !== null);
		let result: string;
		try {
			const request = await invoke<number>('begin_action');
			session.request = request;
			// 番号を受け取る前に取り消されていたら、始めずに取り消しを伝える
			if (running !== session) {
				invoke('cancel_action', { request }).catch(() => {});
				return;
			}
			result = await invoke<string>('run_action', { request, text: parts.body, action });
		} catch (e) {
			// 取り消した後や、次の実行が始まった後に届いた失敗は、知らせない
			if (running !== session) return;
			running = null;
			if (errorCode(e) !== 'action.cancelled') {
				errorTitle = m.action_failed();
				error = actionErrorMessage(e) ?? errorCode(e);
				if (!draftVisible) notifyFinished(m.action_notify_failed({ action: label }));
			}
			await tick();
			textarea?.focus();
			return;
		}
		// 取り消した後に届いた結果は捨てる
		if (running !== session) return;
		// 下書きに出さないアクションは、終わったことだけを知らせる
		if (session.output === 'none') {
			running = null;
			if (draftVisible) showNotice(m.draft_action_done({ action: label }));
			else notifyFinished(m.action_notify_done({ action: label }));
			await tick();
			textarea?.focus();
			return;
		}
		// 隠れている間に届いたら、出し直したときに差し替える（見えていない入力欄にはフォーカスを移せず、差し替えられないため）。
		// それまでは実行中のままにして、入力欄を書き換えさせない
		if (!draftVisible) {
			pendingResult = () => applyResult(session, parts, result);
			notifyFinished(m.action_notify_done({ action: label }));
			return;
		}
		await applyResult(session, parts, result);
	}

	/** 隠れている間に終わったことを、OS の通知で知らせる。押しても何もしない */
	function notifyFinished(message: string) {
		invoke('notify_action_finished', { message }).catch(() => {});
	}

	/** アクションの結果を、出し方に従って入力欄に出す（置き換えるか、差し込む）。差し替える前の中身全体を履歴に積む */
	async function applyResult(
		session: RunningAction,
		parts: ReturnType<typeof splitActionTarget>,
		result: string
	) {
		if (running !== session) return;
		running = null;
		// 実行している間は入力欄を書き換えられないので、中身は始めたときのまま。万一変わっていたら、差し替える範囲がずれるので入れない
		if (text !== session.original) return;
		// 入力欄を編集できる状態に戻してから差し替える（readonly のままでは insertText が効かない）
		await tick();
		if (!textarea) return;
		// 差し替える前の中身全体を積む。履歴から呼び出して書き換えていない文は、もう履歴にあるので積まない。
		// 差し替えは書き換えなので、たどっている途中なら、そこでたどるのをやめる
		if (draftHistory.isBrowsing) draftHistory.stopBrowsing();
		else if (draftHistory.record(session.original)) saveDraftHistory();
		textarea.focus();
		if (session.output === 'insert') {
			textarea.setSelectionRange(session.caret, session.caret);
			insertAsTyped(textarea, result, session.caret, session.caret);
			return;
		}
		textarea.setSelectionRange(session.start, session.end);
		// 前後は渡していないので戻す（AI は Rust 側が結果の前後の空白を落とし、コマンドは末尾の改行を落とす）
		insertAsTyped(textarea, parts.leading + result + parts.trailing, session.start, session.end);
	}

	/** アクションの実行を取り消す。入力欄は元の文のまま、編集できる状態に戻す。取り消したことは知らせない */
	function cancelAction() {
		const session = running;
		if (!session) return;
		running = null;
		pendingResult = null;
		// 番号を受け取る前なら、受け取ったところで executeAction が取り消しを伝える
		if (session.request !== null) {
			invoke('cancel_action', { request: session.request }).catch(() => {});
		}
	}

	/** ホットキーで隠すよう頼まれた。アクションを実行している最中なら、実行は続けたままコピーせずに隠す（元の文を取り違えてコピーしないため） */
	function onHideRequested() {
		if (running) return dismiss();
		return commit();
	}

	function commit() {
		return hideWith('commit', m.copy_failed());
	}

	/** 組み合わせた機器の下書きへ送って隠す。送った下書きも、コピーしたときと同じく履歴に覚える */
	function send() {
		// 送り先にチェックした機器がなければ、送らずに一覧を開いて選んでもらう
		if (!pairedDevices.some((device) => device.sendTo)) {
			targetsOpen = true;
			return;
		}
		return hideWith('send_draft', m.send_failed());
	}

	/** 送り先の一覧を閉じ、入力欄に戻る */
	async function closeTargets() {
		targetsOpen = false;
		await tick();
		textarea?.focus();
	}

	/** 送り先の一覧から送る。チェックが入っていて、つながった機器だけに送る */
	async function sendToTargets(publicKeys: string[]) {
		await closeTargets();
		return hideWith('send_draft', m.send_failed(), publicKeys);
	}

	/**
	 * コピーするか送るかして隠す。隠すのは Rust 側で、渡したら true、空で何もしなかったら false が返る。
	 * 送るときは、targets（公開鍵）を渡せばその機器へ、渡さなければ送り先にチェックした機器へ送る
	 */
	async function hideWith(
		command: 'commit' | 'send_draft',
		failedTitle: string,
		targets?: string[]
	) {
		if (hiding) return;
		hiding = true;
		sending = command === 'send_draft';
		const shownAtCommit = shownCount;
		// 完了を待つ間に打ち直されうるので、コピーに渡した内容を履歴に覚える
		const committed = text;
		// ネイティブ側は invoke の中でウィンドウを隠すので、完了を待つ前にホットキーで再表示されうる。先に空にする予約をしておく。
		// 送るときは失敗しうるので、送っている間に出し直しても空にしない（onShown）。空にするのは送れてから
		clearOnShow = true;
		try {
			// 整えた結果が空でクリップボードを変えなかったときは false が返り、履歴にも覚えない
			const copied = await invoke<boolean>(
				command,
				targets ? { text: committed, targets } : { text: committed }
			);
			// クリップボードを変えたかどうかに関わらず、隠したので履歴をたどっていた状態は終える
			draftHistory.stopBrowsing();
			if (copied && draftHistory.record(committed)) saveDraftHistory();
			// コピーの完了を待つ間に再表示されていたら、そこで空にしてから打ち直した内容なので消さない。
			// 送るときは出し直しても空にしておらず、送っている間は書き換えられないので、中身が同じなら送った内容。
			// 中身が変わっていたとき（空の入力欄に届いた下書きが入ったときなど）は、渡していない内容なので消さない
			if ((sending || shownCount === shownAtCommit) && text === committed) text = '';
			error = '';
		} catch (e) {
			clearOnShow = false;
			if (command === 'send_draft' && isPartialSend(e)) {
				// 一部の機器にだけ届かなかった。原因は出さず、どの機器に届かなかったかだけを出す
				errorTitle = m.send_partial();
				const names = e.devices.map((publicKey) =>
					unbrokenAtHyphens(deviceNames.get(publicKey) ?? publicKey)
				);
				error = m.send_partial_devices({
					devices: new Intl.ListFormat(settings.current?.locale).format(names)
				});
			} else {
				errorTitle = failedTitle;
				// 送れなかったときは、Rust 側が失敗の種類を符号で返すので、何をすればよいかの案内にする
				error = command === 'send_draft' ? lanErrorMessage(e) : errorCode(e);
			}
			// 隠れずに残るので、コピーのボタンで押したときも、そのまま書き続けてキーを使えるよう入力欄に戻す
			textarea?.focus();
		} finally {
			// 終わったら予約は要らない。残すと、後で書いた下書きを次に出したときに消してしまう
			clearOnShow = false;
			hiding = false;
			sending = false;
		}
	}

	// 書きかけがあったので、差し込むか捨てるかを選ぶまで溜めている下書き。届いた順。起動中だけメモリーに持つ
	let received = $state<ReceivedDraft[]>([]);

	/** 入力欄が空ならそのまま入れる。書きかけがあれば溜め、帯で差し込むか捨てるかを選ばせる */
	function onReceived(draft: ReceivedDraft) {
		if (text === '' && received.length === 0) {
			text = draft.text;
			// 隠れている間に入れた中身を、次に出したときに空にしない
			clearOnShow = false;
			return;
		}
		received.push(draft);
	}

	/** 帯の「カーソルの位置に差し込む」。定型文と同じく、取り消しで戻せる形で差し込み、範囲を選んでいたら置き換える */
	function insertReceived() {
		const draft = received.shift();
		if (!draft || !textarea) return;
		textarea.focus();
		insertAsTyped(textarea, draft.text);
	}

	/**
	 * Rust 側に溜まっている届いた下書きを、届いた順に受け取る。画面の読み込み中に届いた分も、読み込み後にここで受け取る。
	 * 並べて取りに行くと、応答の順が入れ替わって届いた順が崩れるので、取りに行っている間に次の知らせが来たら、終わってから取り直す
	 */
	const takeReceived = coalescedSaver(async () => {
		const drafts = await invoke<ReceivedDraft[]>('take_received_drafts');
		for (const draft of drafts ?? []) onReceived(draft);
	});

	function discardReceived() {
		received.shift();
		textarea?.focus();
	}

	async function onShown() {
		shownCount++;
		draftVisible = true;
		// 一覧を出したまま隠れていたら、出し直したときは入力欄から始める。
		// 送り先の一覧は、次に開いたときにつながるかを確かめ直す
		snippetsOpen = false;
		actionsOpen = false;
		folderOpen = false;
		targetsOpen = false;
		// 前に出していたときの知らせは、出し直したら要らない
		notice = '';
		// 変換中に隠れて compositionend が届かなかった場合に備え、出し直すたびに変換中の扱いを解く
		composing = false;
		if (clearOnShow && !sending) {
			text = '';
			clearOnShow = false;
		}
		await tick();
		textarea?.focus();
		const apply = pendingResult;
		pendingResult = null;
		await apply?.();
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
		// アクションを実行している間、Esc は取り消しだけで隠さない。ほかの下書きのキーと履歴のキーは効かない
		if (running) {
			if (isDismissKey(event)) {
				event.preventDefault();
				cancelAction();
			} else if (action) {
				event.preventDefault();
			}
			return;
		}
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
		const direction = historyDirection(event);
		if (direction && textarea && !sending) recallHistory(event, direction, textarea);
	}

	/** ブラウザーとして読み込み直すキー（F5・Ctrl+R と、Shift や Ctrl を足したもの） */
	function isReloadKey(event: KeyboardEvent): boolean {
		if (event.altKey || event.metaKey) return false;
		return event.key === 'F5' || (event.ctrlKey && event.code === 'KeyR');
	}

	/**
	 * 入力欄の外で押したキー。入力欄と一覧は自分で受けるので、そこで止めなかったものだけがここへ届く。
	 * 一覧を開いている間は、下書きの操作のキーを止めるだけにする（一覧は修飾キー付きのキーを使わず、
	 * 止めないと WebView2 の Ctrl+J のダウンロードの一覧や macOS のメニューのキーに届く）。
	 * どちらも開いていなければ、余白や帯をクリックしてフォーカスが入力欄から外れたので、入力欄と同じく Esc と操作のキーを効かせる
	 */
	function onWindowKeydown(event: KeyboardEvent) {
		const handled = event.defaultPrevented;
		// WebView2 は F5 や Ctrl+R で画面を読み込み直し、書きかけが消える。どこにフォーカスがあっても既定の動作を止める。
		// 操作に割り当てたキーなら、止めたうえで下で操作を呼ぶ
		if (isReloadKey(event)) event.preventDefault();
		if (handled || event.target === textarea) return;
		const view = settings.current;
		const action = view ? draftActionFor(event, view.textWindowKeys, view.platform) : null;
		if (snippetsOpen || actionsOpen || folderOpen || targetsOpen) {
			if (action) event.preventDefault();
			return;
		}
		// ボタンにフォーカスがあるときの Enter や Space は、ボタンの操作なので横取りしない
		if (!action && !isDismissKey(event)) return;
		onKeydown(event);
	}

	/**
	 * キーに割り当てた操作を呼ぶ。今は使えない操作（組み合わせた機器がないときの送る、
	 * 届いた下書きがないときの差し込むなど）なら何もせず false を返す
	 */
	function runAction(action: DraftAction): boolean {
		switch (action) {
			case 'copy':
				commit();
				return true;
			case 'send':
				if (!hasPairedDevice) return false;
				send();
				return true;
			case 'settings':
				// 設定を開く間、下書きは Rust 側で隠れる。コピーはしないので書きかけは残り、設定を閉じると出し直される。
				// 設定がすでにあれば、キーだけはトグルとして閉じる。
				invoke('toggle_settings_window');
				return true;
			// 送っている間は入力欄を書き換えない（docs/lan.md「送る」）。書き換えると、送れたときに空にするか決められない
			case 'snippets':
				return !sending && openSnippets();
			case 'actions':
				return !sending && openActions();
			case 'changeFolder':
				return !sending && openFolder();
			case 'historyOlder':
			case 'historyNewer':
				if (sending) return false;
				stepHistory(action === 'historyOlder' ? 'older' : 'newer');
				return true;
			case 'sendTargets':
				// ▼のボタンと同じく、送っている最中は開かない
				if (!hasPairedDevice || sending) return false;
				targetsOpen = true;
				return true;
			case 'insertReceived':
				if (received.length === 0 || sending) return false;
				insertReceived();
				return true;
			case 'discardReceived':
				if (received.length === 0) return false;
				discardReceived();
				return true;
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
			listen(EVENTS.HIDE_REQUESTED, onHideRequested),
			// 隠れても、実行は取り消さずに続ける
			listen(EVENTS.DRAFT_HIDDEN, () => {
				draftVisible = false;
			}),
			listen(EVENTS.DRAFT_RECEIVED, takeReceived),
			listen(EVENTS.DRAFT_HISTORY_CLEARED, () => {
				historyClearedCount += 1;
				draftHistory.clear();
				historySavePending = false;
			})
		]).then((fns) => {
			// 読み込みが終わる前に届いた下書きは、知らせを取り逃がしているので、ここで取りに行く
			takeReceived();
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
<svelte:window onkeydown={onWindowKeydown} />

<main
	class="relative flex h-screen flex-col gap-2 p-2"
	style:--draft-text-light={settings.current?.textColorLight || undefined}
	style:--draft-text-dark={settings.current?.textColorDark || undefined}
>
	<!--
		ボタンはマウスで使うもので、Tab では移らない（tabindex="-1"）。下書きのキーは入力欄で受けているので、
		フォーカスがボタンに移ると Esc や Cmd+Enter が効かなくなる
	-->
	<!-- 履歴の前・次。覚えている履歴がなければ、使えないボタンで入力欄を狭めないよう列ごと出さない -->
	{#if showButtons && draftHistory.hasEntries}
		<div class="flex justify-between">
			<Button
				tabindex={-1}
				variant="ghost"
				size="sm"
				disabled={!draftHistory.canGoOlder || sending || running !== null}
				title={settings.current?.textWindowKeys.historyOlder
					? m.draft_history_older_hint_key({
							keys: formatKeys(
								settings.current.textWindowKeys.historyOlder,
								settings.current.platform
							)
						})
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
				disabled={!draftHistory.canGoNewer || sending || running !== null}
				title={settings.current?.textWindowKeys.historyNewer
					? m.draft_history_newer_hint_key({
							keys: formatKeys(
								settings.current.textWindowKeys.historyNewer,
								settings.current.platform
							)
						})
					: m.draft_history_newer_hint()}
				onclick={() => stepHistory('newer')}
			>
				{m.draft_history_newer()}
				<ChevronRightIcon data-icon="inline-end" />
			</Button>
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
			スクロール位置も同期させることで、実際の文字の裏にちょうど重なる。ここ自体は入力を受けない（pointer-events-none）
		-->
		<div
			class="pointer-events-none absolute inset-y-0 left-0 z-0 overflow-hidden rounded-lg border border-transparent px-2.5 py-2 text-base md:text-sm [&_*]:[word-break:inherit]"
			style="right: {scrollbarWidth}px; font-family: {fontFamily}; font-size: {fontSize}px; line-height: 1.5; color: transparent; white-space: pre-wrap; word-break: break-word;"
			aria-hidden="true"
		>
			<div style="transform: translate({-scrollLeft}px, {-scrollTop}px);">
				{#each previewSegmentsList as segment, index (index)}{#if segment.highlighted}<mark
							bind:this={markElements[index]}
							class="rounded-[0.1em] bg-yellow-300/60 text-transparent dark:bg-yellow-400/40"
							>{segment.text}</mark
						>{:else}{segment.text}{/if}{/each}
			</div>
		</div>
		<!-- アクションを実行している間は、書き換えと届いた結果がぶつからないよう、編集できなくして薄くする -->
		<Textarea
			bind:ref={textarea}
			bind:value={text}
			class={[
				'relative z-10 field-sizing-fixed h-full min-h-0 resize-none bg-transparent dark:bg-transparent',
				running && 'opacity-60'
			]}
			style="font-family: {fontFamily}; font-size: {fontSize}px; line-height: 1.5"
			spellcheck="false"
			readonly={sending || running !== null}
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
	{#if running}
		<div class="flex items-center gap-2 px-1">
			<p role="status" class="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground">
				<LoaderCircleIcon class="size-4 shrink-0 animate-spin" aria-hidden="true" />
				<span class="truncate">{m.draft_running_action({ action: running.label })}</span>
			</p>
			<Button
				variant="outline"
				size="sm"
				class="shrink-0"
				onclick={async () => {
					cancelAction();
					// 押したボタンは消えるので、入力欄に戻す
					await tick();
					textarea?.focus();
				}}
			>
				{m.draft_cancel_action()}
			</Button>
		</div>
	{:else if notice}
		<p role="status" class="flex items-center gap-2 px-1 text-sm text-muted-foreground">
			<CircleCheckIcon class="size-4 shrink-0" aria-hidden="true" />
			<span class="truncate">{notice}</span>
		</p>
	{/if}
	{#if showButtons && settings.current}
		{@const platform = settings.current.platform}
		{@const keys = settings.current.textWindowKeys}
		<!--
			キーを添えるのはコピーだけ。ほかは狭い窓に文字を詰め込まないよう、マウスを重ねたときの説明に出す。
			列が狭いとき（最小の幅の近く）は、定型文とアクションをアイコンだけにする。英語でコピーのキーが3つだと、はみ出していた
		-->
		<div class="@container flex items-center gap-1">
			<Button
				tabindex={-1}
				variant="ghost"
				size="icon-sm"
				aria-label={m.draft_settings()}
				title={keyHint(m.draft_settings_hint(), keys.settings, platform)}
				disabled={running !== null}
				onclick={() => invoke('open_settings_window')}
			>
				<SettingsIcon />
			</Button>
			<Button
				tabindex={-1}
				variant="ghost"
				size="sm"
				title={keyHint(m.draft_snippets_hint(), keys.snippets, platform)}
				disabled={sending || running !== null}
				onclick={openSnippets}
			>
				<TextQuoteIcon data-icon="inline-start" />
				<span class="@max-[30rem]:sr-only">{m.draft_snippets()}</span>
			</Button>
			<Button
				tabindex={-1}
				variant="ghost"
				size="sm"
				title={keyHint(m.draft_actions_hint(), keys.actions, platform)}
				disabled={sending || running !== null}
				onclick={openActions}
			>
				<SparklesIcon data-icon="inline-start" />
				<span class="@max-[30rem]:sr-only">{m.draft_actions()}</span>
			</Button>
			{#if hasPairedDevice}
				<!-- 本体でチェックした機器へ送り、▼で送り先の一覧を開く -->
				<div class="ml-auto flex">
					<Button
						tabindex={-1}
						variant="outline"
						size="sm"
						class="rounded-r-none"
						title={keyHint(m.draft_send_hint(), keys.send, platform)}
						disabled={sending || running !== null}
						onclick={send}
					>
						<SendIcon data-icon="inline-start" />
						{sending ? m.draft_sending() : m.draft_send()}
					</Button>
					<Button
						tabindex={-1}
						variant="outline"
						size="sm"
						class="-ml-px rounded-l-none px-1.5"
						aria-label={m.draft_send_targets()}
						title={keyHint(m.draft_send_targets(), keys.sendTargets, platform)}
						disabled={sending || running !== null}
						onclick={() => (targetsOpen = true)}
					>
						<ChevronDownIcon />
					</Button>
				</div>
			{/if}
			<!-- 変換中に押すと、入力欄からフォーカスが外れて未確定の文字が確定し、その内容でコピーする -->
			<Button
				tabindex={-1}
				size="sm"
				class={hasPairedDevice ? '' : 'ml-auto'}
				disabled={running !== null}
				onclick={commit}
			>
				{m.draft_copy()}
				{#if keys.copy}
					<Kbd.Group>
						{#each keyLabels(keys.copy, platform) as label (label)}
							<Kbd.Root>{label}</Kbd.Root>
						{/each}
					</Kbd.Group>
				{/if}
			</Button>
		</div>
	{/if}
	{#if received.length > 0 && !running}
		{@const draft = received[0]}
		<!-- 1件ずつ知らせる。書きかけを消さないよう、差し込むか捨てるかを選ぶまで溜めておく。アクションを実行している間は出さず、終わってから知らせる -->
		<Alert.Root>
			<SendIcon />
			<Alert.Title>{m.draft_received({ device: draft.from })}</Alert.Title>
			<div class="col-start-2 flex gap-2 pt-1">
				<Button
					tabindex={-1}
					variant="outline"
					size="sm"
					title={settings.current
						? keyHint(
								m.draft_received_insert(),
								settings.current.textWindowKeys.insertReceived,
								settings.current.platform
							)
						: undefined}
					disabled={sending}
					onclick={insertReceived}
				>
					{m.draft_received_insert()}
				</Button>
				<Button
					tabindex={-1}
					variant="ghost"
					size="sm"
					title={settings.current
						? keyHint(
								m.draft_received_discard(),
								settings.current.textWindowKeys.discardReceived,
								settings.current.platform
							)
						: undefined}
					onclick={discardReceived}
				>
					{m.draft_received_discard()}
				</Button>
			</div>
		</Alert.Root>
	{/if}
	{#if error}
		<Alert.Root variant="destructive">
			<CircleAlertIcon />
			<Alert.Title>{errorTitle}</Alert.Title>
			<Alert.Description class="whitespace-pre-line">{error}</Alert.Description>
			{#if noCredit}
				<div class="col-start-2 pt-1">
					<Button
						tabindex={-1}
						variant="outline"
						size="sm"
						onclick={() => invoke('open_mawok_buy_page')}
					>
						{m.settings_mawok_buy()}
					</Button>
				</div>
			{/if}
		</Alert.Root>
	{/if}
	{#if snippetsOpen && settings.current}
		<!-- 一覧を出している間は、フォーカスが一覧にあるので、入力欄のキー（Cmd+Enter など）は効かない -->
		<TextPalette
			items={settings.current.snippets}
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
			actionAt="end"
			onpick={(snippet) => insertSnippet(snippet.body)}
			onclose={closeSnippets}
		/>
	{/if}
	{#if actionsOpen && settings.current}
		<!-- 定型文の一覧と同じ出し方・絞り込み・選び方・閉じ方 -->
		<TextPalette
			items={actionItems}
			platform={settings.current.platform}
			toggleKey={settings.current.textWindowKeys.actions}
			listLabel={m.actions_list()}
			searchLabel={m.actions_search()}
			emptyMessage={settings.current.textWindowKeys.settings
				? m.actions_empty({
						settings: formatKeys(
							settings.current.textWindowKeys.settings,
							settings.current.platform
						)
					})
				: m.actions_empty_no_key()}
			noMatchMessage={m.actions_no_match()}
			action={freeInputAction}
			onpick={(item) => executeAction(item.action, snippetLabel(item))}
			onclose={closeActions}
		/>
	{/if}
	{#if folderOpen && settings.current}
		<FolderPalette
			current={folder}
			platform={settings.current.platform}
			toggleKey={settings.current.textWindowKeys.changeFolder}
			onsubmit={changeFolder}
			oncomplete={completeFolder}
			onclose={closeFolder}
		/>
	{/if}
	{#if targetsOpen && hasPairedDevice && settings.current}
		<!-- 一覧を出している間は、フォーカスが一覧にあるので、入力欄のキーは効かない -->
		<SendTargetPalette
			devices={pairedDevices}
			platform={settings.current.platform}
			targetsKey={settings.current.textWindowKeys.sendTargets}
			onsend={sendToTargets}
			onclose={closeTargets}
			onerror={(message) => {
				errorTitle = m.draft_send_targets_save_failed();
				error = message;
			}}
		/>
	{/if}
</main>

<style>
	/*
		案内は、入力した文字と見間違えないよう、緑みの薄い色の斜体にする。
		部品の placeholder:text-muted-foreground は @layer utilities の中なので、層の外に書いたこちらが勝つ
	*/
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
	main :global(textarea::placeholder) {
		color: var(--draft-guidance);
		font-style: italic;
	}
</style>
