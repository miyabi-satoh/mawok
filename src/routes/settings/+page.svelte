<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import EraserIcon from '@lucide/svelte/icons/eraser';
	import { invoke } from '@tauri-apps/api/core';
	import { commandCaller, okValue } from '$lib/call';
	import { clamp } from '$lib/clamp';
	import { DEFAULT_TEXT_COLORS, normalizeTextColor, type TextColorTheme } from '$lib/color';
	import { EVENTS } from '$lib/bindings/constants';
	import type { AccountStatus } from '$lib/bindings/AccountStatus';
	import { errorCode } from '$lib/errors';
	import SyncToggle from '$lib/components/sync-toggle.svelte';
	import BackupDialog from '$lib/components/backup-dialog.svelte';
	import SettingsAi from '$lib/components/settings-ai.svelte';
	import SettingsSnippets from '$lib/components/settings-snippets.svelte';
	import SettingsMawokAccount from '$lib/components/settings-mawok-account.svelte';
	import SettingsMawokDevices from '$lib/components/settings-mawok-devices.svelte';
	import SettingsModifiedMark from '$lib/components/settings-modified-mark.svelte';
	import SettingsRow from '$lib/components/settings-row.svelte';
	import SettingsSection from '$lib/components/settings-section.svelte';
	import SettingsSync from '$lib/components/settings-sync.svelte';
	import SettingsSyncNote from '$lib/components/settings-sync-note.svelte';
	import SettingSyncToggle from '$lib/components/setting-sync-toggle.svelte';
	import SettingsUpdate from '$lib/components/settings-update.svelte';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import { DEFAULT_DRAFT_FONT_SIZE, MAX_DRAFT_FONT_SIZE, MIN_DRAFT_FONT_SIZE } from '$lib/font';
	import { draftGuidance } from '$lib/guidance';
	import { focusFirstField } from '$lib/focus-field';
	import { isBlankReplacement } from '$lib/blank-rows';
	import { DEFAULT_DRAFT_HISTORY_SIZE, MAX_DRAFT_HISTORY_SIZE } from '$lib/history.svelte';
	import { modifiedName } from '$lib/modified-settings';
	import { onEvent } from '$lib/on-event';
	import { AiModelEditor } from '$lib/ai-model-editor.svelte';
	import { SnippetsEditor } from '$lib/snippets-editor.svelte';
	import KeyCaps from '$lib/components/key-caps.svelte';
	import ListFilter from '$lib/components/list-filter.svelte';
	import { matchedKeys, showsFilter, shownRows } from '$lib/list-filter';
	import { actionErrorMessage } from '$lib/action-errors';
	import { RowList } from '$lib/row-list.svelte';
	import { coalescedSaver } from '$lib/saver';
	import { CHAR_WIDTH_KINDS, LANGUAGES, PUNCTUATION_STYLES, THEMES } from '$lib/setting-options';
	import { settingsCategories } from '$lib/settings-categories';
	import {
		DRAFT_ACTIONS_IN_SETTINGS,
		draftActionLabel,
		formatKeys,
		hasNoModifiers,
		isCloseWindowKey,
		isImeKey,
		isKeyRejection,
		keyRejectionMessage,
		toAccelerator,
		toDraftKey,
		type DraftAction
	} from '$lib/keys';
	import { m } from '$lib/paraglide/messages';
	import {
		settings,
		type Replacement,
		type SettingsView,
		type Snippet
	} from '$lib/settings.svelte';

	/** サイドバーの分類。選んだ分類は覚えず、開くたびに先頭の「一般」から始める */
	const categories = settingsCategories();
	let category = $state('general');
	const categoryLabel = $derived(categories.find(({ value }) => value === category)?.label() ?? '');

	/** 記録しているキー。ホットキーか、下書きウィンドウの操作か。記録していなければ null */
	let recording = $state<'hotkey' | DraftAction | null>(null);
	let hotkeyError = $state('');
	/** 下書きウィンドウの操作のキーを割り当てられなかった理由。出すのはその操作の行の下 */
	let keyError = $state<{ action: DraftAction; message: string } | null>(null);
	let error = $state('');

	const showError = (message: string) => (error = message);
	const settingsFailed = (e: unknown) => m.settings_failed({ error: errorCode(e) });
	const callSettings = commandCaller(settingsFailed, showError);
	/** アクションのコマンドを呼ぶ。失敗したら、アクションの符号なら何をすればよいかの案内に、そうでなければ設定の失敗として出す */
	const callActions = commandCaller((e) => actionErrorMessage(e) ?? settingsFailed(e), showError);
	/** 欄の下に出さない失敗を、アクションの符号なら何をすればよいかの案内に、そうでなければ設定の失敗として出す */
	const showActionError = (e: unknown) => showError(actionErrorMessage(e) ?? settingsFailed(e));
	/** 設定ウィンドウを載せたときの Mawok のアカウントの様子。null はサインインしていないか、問い合わせられなかった。 */
	let mawokAccountStatus = $state<AccountStatus | null | undefined>(undefined);
	let refreshingMawokAccountStatus = false;
	/** 問い合わせの通し番号。サインインやサインアウトの前に出した問い合わせの答えを捨てる */
	let mawokAccountRefresh = 0;

	/** `changed` はサインイン・サインアウトの直後。前のアカウントの様子を出したままにせず、答えが来るまで空にする */
	async function refreshMawokAccountStatus(changed = false) {
		if (changed) mawokAccountStatus = undefined;
		else if (refreshingMawokAccountStatus) return;
		const refresh = ++mawokAccountRefresh;
		refreshingMawokAccountStatus = true;
		// 裏で確かめ直すだけなので、つながらなくても画面のエラーにはしない。確かめられなかったことは「AI」の残りの欄が出す。
		// 資格情報を読めなかったときは Rust 側がサインインしていない扱いにするので、「サインイン」からやり直せる。
		let status: AccountStatus | null;
		try {
			status = await invoke<AccountStatus | null>('mawok_account_status');
		} catch {
			if (refresh !== mawokAccountRefresh) return;
			refreshingMawokAccountStatus = false;
			mawokAccountStatus = null;
			return;
		}
		if (refresh !== mawokAccountRefresh) return;
		refreshingMawokAccountStatus = false;
		mawokAccountStatus = status;
	}

	// 窓口で買い足したり Pro を申し込んだりして戻ったとき、設定を開き直さず表示を更新する。
	$effect(() => {
		const onFocus = () => void refreshMawokAccountStatus();
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	});

	function openAccount() {
		category = 'account';
	}

	// テキストウィンドウのエラーの帯から頼まれたら、「AI」に移る。設定ウィンドウを作る前の頼みは、
	// イベントでは届かないので、載せたときに Rust 側に尋ねる
	$effect(() => {
		const show = async () => {
			if (await invoke<boolean>('take_ai_settings_request').catch(() => false)) category = 'ai';
		};
		void show();
		return onEvent(EVENTS.AI_SETTINGS_REQUESTED, show);
	});

	/** バックアップから戻す窓を出しているか */
	let backupOpen = $state(false);
	/** 「今すぐバックアップ」の結果。設定が変わると今の設定のことでなくなるので消す */
	let backupNotice = $state('');
	$effect(() => {
		void settings.current;
		backupNotice = '';
	});

	async function backUp() {
		backupNotice = '';
		const written = okValue(await callSettings<boolean>('back_up_settings'));
		if (written !== undefined)
			backupNotice = written ? m.settings_backup_done() : m.settings_backup_unchanged();
	}

	/** 設定を変えるコマンドを呼び、できたかを返す。変わった設定は settings-changed で届き、画面に反映される */
	async function run(command: string, args?: Record<string, unknown>) {
		return (await callSettings(command, args)).ok;
	}

	/** 行の保存で Rust が足した ID を、入力中の行を作り直さず画面側へ戻す。 */
	async function saveItems<T>(
		command: string,
		args: Record<string, unknown>
	): Promise<T[] | undefined> {
		return okValue(await callSettings<T[]>(command, args));
	}

	async function startRecording(target: 'hotkey' | DraftAction) {
		hotkeyError = '';
		keyError = null;
		recording = target;
		// 押したキーで下書きウィンドウが出ないように、今のホットキーを止める。
		// 下書きの操作の記録でも止め、ホットキーと同じキーを押したら重なりとして知らせる
		await invoke('pause_hotkey');
	}

	async function stopRecording() {
		recording = null;
		await invoke('resume_hotkey');
	}

	async function recordKey(event: KeyboardEvent) {
		const view = settings.current;
		const target = recording;
		if (!view || !target) return;
		// IME が処理したキー（変換中の Esc など）は、変換の操作なので記録にも中止にも使わない
		if (isImeKey(event)) return;
		// 記録中に出る「既定に戻す」「割り当てを解除」「キャンセル」へ、キーボードだけでも移って押せるようにする。
		// 修飾キーなしの Tab と、ボタンの上での Enter・Space は、記録できるキーではないので通す
		const onButton = event.target instanceof Element && event.target.closest('button') !== null;
		if (
			hasNoModifiers(event) &&
			(event.key === 'Tab' || (onButton && (event.key === 'Enter' || event.key === ' ')))
		) {
			return;
		}
		event.preventDefault();
		if (event.key === 'Escape') {
			await stopRecording();
			return;
		}
		const accelerator =
			target === 'hotkey' ? toAccelerator(event, view.platform) : toDraftKey(event, view.platform);
		// 修飾キーだけのときや、登録できないキーのときは、次のキーを待つ
		if (!accelerator) return;
		recording = null;
		if (target === 'hotkey') {
			await setHotkey(accelerator);
			return;
		}
		try {
			await invoke('set_draft_key', { action: target, key: accelerator });
		} catch (e) {
			keyError = { action: target, message: keyRejectionMessage(e, accelerator, view.platform) };
		} finally {
			await invoke('resume_hotkey');
		}
	}

	/** ホットキーを変える。空文字で外す。記録中なら記録をやめる */
	async function setHotkey(accelerator: string) {
		const view = settings.current;
		if (!view) return;
		hotkeyError = '';
		recording = null;
		try {
			// 成功しても失敗しても、止めていたホットキーは Rust 側で戻す
			await invoke('set_hotkey', { accelerator });
		} catch (e) {
			// 下書きの操作と重なって断られたときは符号が返る。それ以外は OS に登録できなかった
			hotkeyError = isKeyRejection(e)
				? keyRejectionMessage(e, accelerator, view.platform)
				: m.settings_hotkey_unavailable({
						keys: formatKeys(accelerator, view.platform),
						current: view.hotkey ? formatKeys(view.hotkey, view.platform) : m.settings_key_none()
					});
		}
	}

	/** 操作のキーを既定に戻す。既定のキーをほかで使っていれば、戻さずにその旨を出す */
	async function resetDraftKey(action: DraftAction) {
		const view = settings.current;
		if (!view) return;
		keyError = null;
		if (recording === action) await stopRecording();
		try {
			await invoke('reset_draft_key', { action });
		} catch (e) {
			keyError = {
				action,
				message: keyRejectionMessage(e, view.defaultDraftKeys[action], view.platform)
			};
		}
	}

	async function clearDraftKey(action: DraftAction) {
		keyError = null;
		if (recording === action) await stopRecording();
		await run('set_draft_key', { action, key: '' });
	}

	/**
	 * 置き換え辞書の行。打っている途中に Rust 側からの反映で打ち消されないよう、画面側で持つ。
	 * 設定は画面が出る前に読み終わっている（src/hooks.client.ts）ので、最初の1回だけ写して以降は画面側が持ち主になる
	 */
	const replacements = new RowList<Replacement>(
		settings.current?.replacements ?? [],
		(replacements) => saveItems<Replacement>('set_replacements', { replacements }),
		isBlankReplacement
	);

	/** 定型文と AI のモデル。どちらの分類も開いている間だけ描くので、分類を移っても消えないよう本体が持つ */
	const snippetsEditor = new SnippetsEditor(settings.current, callActions);
	const aiModel = new AiModelEditor(settings.current, callActions);
	$effect(() => {
		if (settings.current) snippetsEditor.followLocale(settings.current);
	});

	let replacementFilter = $state('');
	/** 絞り込みに当たった置き換え辞書の行の画面用 key。語を変えたときにだけ求め直す。null なら絞り込んでいない */
	const replacementMatches = $derived(
		matchedKeys(
			() => replacements.rows,
			replacementFilter,
			(row) => [row.from, row.to]
		)
	);
	const shownReplacements = $derived(shownRows(replacements.rows, replacementMatches));

	// 下書きウィンドウから定型文を足したら、開いている設定画面の並びにも足す。
	// 足さないと、次に設定画面で直したときに、足す前の並びで保存して消してしまう。
	// add は並び全体を保存し直すので、足す前の並びの保存が遅れて届いても、その後に保存して上書きする
	$effect(() =>
		onEvent<Snippet>(EVENTS.SNIPPET_ADDED, (snippet) => snippetsEditor.snippets.add(snippet))
	);

	/** フォントの設定。打っている途中に Rust 側からの反映で打ち消されないよう、辞書と同じく画面側で持つ */
	let fontFamily = $state(settings.current?.textFontFamily ?? '');
	let fontSize = $state(settings.current?.textFontSize ?? DEFAULT_DRAFT_FONT_SIZE);

	const saveFont = coalescedSaver(() =>
		run('set_draft_font', { family: fontFamily, size: fontSize })
	);

	/** 履歴の件数。打っている途中に Rust 側からの反映で打ち消されないよう、フォントと同じく画面側で持つ */
	const initialHistorySize = settings.current?.textHistorySize ?? DEFAULT_DRAFT_HISTORY_SIZE;
	let historySize = $state(initialHistorySize);
	/** 欄に打っている値。空や打っている途中の値もあるので、保存する件数とは別に持つ */
	let historySizeInput = $state<number | null>(initialHistorySize);
	/** 件数を保存しに行った回数。保存を待つ間に入れ直されたかを見分ける */
	let historySizeChanges = 0;

	const saveHistorySize = coalescedSaver(async () => {
		const change = historySizeChanges;
		// 保存できなければ、画面の値を Rust 側に残っている今の件数に戻す。戻さないと、保存されていない値が欄に残る。
		// 保存を待つ間に入れ直されていたら戻さない。その値は、この後の保存し直しで保存する。
		// 値ではなく回数で見るのは、10 → 20 → 10 と入れ直して同じ値に戻ったときも、最後に入れた値を残すため
		if (
			!(await run('set_draft_history_size', { size: historySize })) &&
			historySizeChanges === change
		) {
			historySize = settings.current?.textHistorySize ?? DEFAULT_DRAFT_HISTORY_SIZE;
			historySizeInput = historySize;
		}
	});

	/**
	 * 欄から離れたとき（Enter でも）に件数を保存する。打つたびに保存すると、50 を 30 に打ち直す途中の 3 や、
	 * 消しかけの 0 で、下書きの履歴がその場で消えてしまう（件数を減らすとすぐ忘れるため）
	 */
	function commitHistorySize() {
		const size = Number(historySizeInput);
		// 空のまま離れたら、保存せずに今の件数へ戻す。0 は履歴を使わない値なので保存する
		if (historySizeInput == null || String(historySizeInput) === '' || !Number.isFinite(size)) {
			historySizeInput = historySize;
			return;
		}
		// 画面側でも範囲に収める。整数でない値や u16 に収まらない値は、invoke が受け取れずに保存が落ちる
		historySize = clamp(Math.round(size), 0, MAX_DRAFT_HISTORY_SIZE);
		historySizeInput = historySize;
		historySizeChanges++;
		saveHistorySize();
	}

	function clearHistory() {
		run('clear_draft_history');
	}

	/** 入力欄の案内。null は既定の案内。打っている途中に Rust 側からの反映で打ち消されないよう、フォントと同じく画面側で持つ */
	let guidance = $state(settings.current?.inputGuidance ?? null);
	/** 欄に出す文。既定のときは、下書きに出るのと同じ既定の案内を、今の言語とホットキーで作って見せる */
	const guidanceText = $derived(
		settings.current
			? draftGuidance(
					guidance,
					settings.current.hotkey,
					settings.current.textWindowKeys,
					settings.current.platform
				)
			: ''
	);

	const saveGuidance = coalescedSaver(() => run('set_draft_guidance', { guidance }));

	function resetGuidance() {
		guidance = null;
		saveGuidance();
	}

	/** 文字色の行。ライトとダークで同じ形の欄を並べる */
	const textColorRows: {
		theme: TextColorTheme;
		label: () => string;
		pickLabel: () => string;
	}[] = [
		{
			theme: 'light',
			label: m.settings_draft_text_color_light,
			pickLabel: m.settings_draft_text_color_pick_light
		},
		{
			theme: 'dark',
			label: m.settings_draft_text_color_dark,
			pickLabel: m.settings_draft_text_color_pick_dark
		}
	];

	const initialTextColors = {
		light: settings.current?.textColorLight ?? '',
		dark: settings.current?.textColorDark ?? ''
	};
	/** 保存する文字色（小文字の #rrggbb か空）。打っている途中に Rust 側からの反映で打ち消されないよう、画面側で持つ */
	const textColors = $state<Record<TextColorTheme, string>>({ ...initialTextColors });
	/** 欄に打った文字。読めない値を打っている途中でも消さないよう、保存する色とは別に持つ */
	const textColorInputs = $state<Record<TextColorTheme, string>>({
		light: initialTextColors.light || DEFAULT_TEXT_COLORS.light,
		dark: initialTextColors.dark || DEFAULT_TEXT_COLORS.dark
	});
	const textColorErrors = $state<Record<TextColorTheme, string>>({ light: '', dark: '' });

	const saveTextColor = coalescedSaver(() =>
		run('set_draft_text_color', { light: textColors.light, dark: textColors.dark })
	);

	/**
	 * 欄か色見本で文字色を変える。読めない値は保存せず、その旨を出す。空と標準の色は、既定（空）として保存する。
	 * 欄には既定のときも標準の色を値として見せる。空の欄では、既定が効いているのか入れていないのかが分からないため
	 */
	function setTextColor(theme: TextColorTheme, value: string) {
		textColorInputs[theme] = value;
		const color = normalizeTextColor(value);
		if (color === null) {
			textColorErrors[theme] = m.settings_draft_text_color_invalid({ value });
			return;
		}
		textColorErrors[theme] = '';
		textColors[theme] = color === DEFAULT_TEXT_COLORS[theme] ? '' : color;
		saveTextColor();
	}

	/** 欄を空にしたまま離れたら、既定に戻ったことが分かるよう標準の色を出す */
	function showDefaultTextColor(theme: TextColorTheme) {
		if (textColorInputs[theme].trim() === '') textColorInputs[theme] = DEFAULT_TEXT_COLORS[theme];
	}

	// 同期やバックアップから戻すことで設定が替わったら、画面側で持っている一覧と欄を、新しい設定から写し直す。
	// 写し直さないと、次に画面で直したときに、届く前の並びや値で保存して、届いた分を消してしまう。
	// Rust 側は、通信の間に画面からの保存が無かったときだけ知らせるので、打った内容は届いた設定に入っている
	$effect(() =>
		onEvent<SettingsView>(EVENTS.CONFIG_REPLACED, (view) => {
			replacements.recopy(view.replacements, true);
			snippetsEditor.recopy(view);
			aiModel.switchService(view.aiModels, view.aiService);
			fontFamily = view.textFontFamily;
			fontSize = view.textFontSize;
			// 保存の前の、打っている途中の値（離れるまで保存しない件数、読めない色）は消さない
			if (historySizeInput === historySize) historySizeInput = view.textHistorySize;
			historySize = view.textHistorySize;
			guidance = view.inputGuidance;
			for (const theme of ['light', 'dark'] as const) {
				const color = theme === 'light' ? view.textColorLight : view.textColorDark;
				textColors[theme] = color;
				if (!textColorErrors[theme]) textColorInputs[theme] = color || DEFAULT_TEXT_COLORS[theme];
			}
		})
	);

	function addReplacement() {
		// 置き換える前の文字列が空の行は何もしないので、書きかけのまま保存してよい
		replacementFilter = '';
		const row = replacements.addBlank({ id: '', from: '', to: '', enabled: true, sync: true });
		focusFirstField(`replacement-${row.key}`);
	}

	/** キーの記録中でないときのキー。記録中の Esc は記録の中止なので、そちらが受け取る */
	function onKeydown(event: KeyboardEvent) {
		const platform = settings.current?.platform;
		// 確かめや選ぶ画面のダイアログ（AI の了解・同期のリセット・バックアップから戻す）を出している間は、Esc で設定画面を閉じない
		if (document.querySelector('[role="alertdialog"]')) return;
		// 行の「…」メニューなど、開いている部品が受け持った Esc（bits-ui が preventDefault する）では、設定画面は閉じない。
		// フォーカスの位置では、開いた直後のまだメニューに移っていない間を見分けられず、
		// DOM の有無では、閉じるアニメーションの間の次の Esc まで止めてしまう
		if (event.key === 'Escape' && event.defaultPrevented) return;
		if (platform && isCloseWindowKey(event, platform)) {
			event.preventDefault();
			invoke('close_settings_window');
		}
	}

	/** 設定ウィンドウは隠して作られるので、画面を描いてから表示させる */
	function showWindow() {
		invoke('show_settings_window');
		void refreshMawokAccountStatus();
	}
</script>

<!-- 記録中の表示。ホットキーと下書きの操作で同じ形にする -->
{#snippet recordingStatus()}
	<div class="flex items-center gap-1">
		<div
			role="status"
			class="flex h-8 items-center rounded-lg border border-ring px-2.5 text-sm whitespace-nowrap text-muted-foreground ring-3 ring-ring/50"
		>
			{m.settings_hotkey_recording()}
		</div>
		<Button variant="ghost" onclick={stopRecording}>{m.common_cancel()}</Button>
	</div>
{/snippet}

<!-- 記録中に出す「既定に戻す」「割り当てを解除」。狭い窓でも行に収まるようアイコンにし、名前はツールチップと読み上げで出す -->
{#snippet keyRecordingStatus(key: string, defaultKey: string, reset: () => void, clear: () => void)}
	<!-- 狭い窓では、ボタンだけを次の行へ送らず、まとめて次の行の右端へ送る（置き場の側が flex-wrap と ml-auto を持つ） -->
	<div class="flex items-center gap-1">
		{@render recordingStatus()}
		<Button
			variant="ghost"
			size="icon"
			aria-label={m.settings_key_reset_action()}
			title={m.settings_key_reset_action()}
			disabled={key === defaultKey}
			onclick={reset}
		>
			<RotateCcwIcon />
		</Button>
		<Button
			variant="ghost"
			size="icon"
			aria-label={m.settings_key_clear_action()}
			title={m.settings_key_clear_action()}
			disabled={key === ''}
			onclick={clear}
		>
			<EraserIcon />
		</Button>
	</div>
{/snippet}

<svelte:window
	onkeydown={recording ? recordKey : onKeydown}
	onblur={recording ? stopRecording : undefined}
/>

{#if settings.current}
	{@const view = settings.current}
	{#snippet syncSetting(name: string, label: string)}
		<SettingSyncToggle {view} {name} {label} call={callSettings} />
	{/snippet}
	<!-- 今のキーを出すボタン。キーの表示そのものを押して記録を始める（macOS のシステム設定のキーボードショートカットと同じ） -->
	{#snippet keyButton(target: 'hotkey' | DraftAction, key: string, label: string, classes: string)}
		<Button
			variant="outline"
			class={classes}
			aria-label={label}
			onclick={() => startRecording(target)}
		>
			{#if key}
				<KeyCaps {key} platform={view.platform} />
			{:else}
				<span class="px-1 text-muted-foreground">{m.settings_key_none()}</span>
			{/if}
		</Button>
	{/snippet}
	<!-- スイッチ1個の設定の行。name は設定の項目名で、既定から変えた印と同期の印に使う -->
	{#snippet switchRow(
		name: string,
		id: string,
		label: string,
		checked: boolean,
		command: string,
		description?: string
	)}
		<SettingsRow modified={modifiedName(view, name)}>
			<Field.Field orientation="horizontal" class="min-h-8">
				<div class="flex-auto">
					<Field.Label class="inline" for={id}>{label}</Field.Label>
					{@render syncSetting(name, label)}
				</div>
				<Switch {id} bind:checked={() => checked, (enabled) => run(command, { enabled })} />
			</Field.Field>
			{#if description}
				<Field.Description class="leading-snug">{description}</Field.Description>
			{/if}
		</SettingsRow>
	{/snippet}
	<main class="settings-page flex h-dvh" {@attach showWindow}>
		<Tabs.Root
			orientation="vertical"
			class="min-w-0 flex-1 gap-0"
			bind:value={
				() => category,
				(value) => {
					// 記録中の表示は「キー操作」の分類の中にしかない。ほかへ移っても記録を続けると、
					// 見えないままキーを横取りし、止めたホットキーも戻らない
					if (recording) stopRecording();
					// 足したまま書かなかった行は、分類を離れたら捨てる。戻ったときに「未入力」の行が残らないように
					replacements.dropBlanks();
					snippetsEditor.snippets.dropBlanks();
					category = value;
				}
			}
		>
			<Tabs.List
				class="w-48 shrink-0 justify-start gap-0.5 rounded-none border-r border-sidebar-border bg-sidebar p-2 group-data-vertical/tabs:h-full"
			>
				{#each categories as { value, label, icon: Icon }, index (value)}
					<Tabs.Trigger
						{value}
						class="h-8 flex-none px-2 data-active:border-transparent data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground data-active:shadow-none group-data-[variant=default]/tabs-list:data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-sidebar-accent dark:data-active:text-sidebar-accent-foreground {index ===
						categories.length - 1
							? 'mt-auto'
							: ''}"
					>
						<Icon data-icon="inline-start" />
						{label()}
					</Tabs.Trigger>
				{/each}
			</Tabs.List>
			<!-- 入りきらない分は、ウィンドウを伸ばさずにこの区画の中でスクロールする -->
			<div class="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
				<h1 class="text-lg font-semibold">{categoryLabel}</h1>
				{#if category === 'about'}
					<div class="flex flex-col items-center gap-2 text-center">
						<img src="/icon.png" alt="" class="size-16" />
						<strong>
							{{
								macos: m.settings_app_name_macos,
								windows: m.settings_app_name_windows,
								linux: m.settings_app_name_linux
							}[view.platform]()}
						</strong>
						<span>{m.settings_app_catchphrase()}</span>
						<span class="text-muted-foreground"
							>{m.settings_version({ version: view.version })}</span
						>
						<!-- この画面の primary は文字と同じ色なので、下線を常に引いてリンクと分かるようにする -->
						<div class="flex gap-3">
							<Button
								variant="link"
								class="h-auto p-0 underline"
								onclick={() => run('open_terms_page')}
							>
								{m.settings_terms()}
							</Button>
							<Button
								variant="link"
								class="h-auto p-0 underline"
								onclick={() => run('open_privacy_page')}
							>
								{m.settings_privacy()}
							</Button>
							<Button
								variant="link"
								class="h-auto p-0 underline"
								onclick={() => run('open_contact_page')}
							>
								{m.settings_contact()}
							</Button>
						</div>
					</div>
				{/if}
				<Tabs.Content value="general">
					<div class="flex flex-col gap-5">
						<SettingsSection title={m.settings_section_startup()}>
							<SettingsRow modified={modifiedName(view, 'autostart')}>
								<Field.Field orientation="horizontal" class="min-h-8">
									<Field.Label for="autostart">{m.settings_autostart()}</Field.Label>
									<Switch
										id="autostart"
										bind:checked={
											() => view.autostart, (enabled) => run('set_autostart', { enabled })
										}
									/>
								</Field.Field>
							</SettingsRow>
						</SettingsSection>
						<SettingsSection title={m.settings_section_draft_window()}>
							{@render switchRow(
								'text_window_always_on_top',
								'draft-always-on-top',
								m.settings_draft_always_on_top(),
								view.textWindowAlwaysOnTop,
								'set_draft_always_on_top'
							)}
							{@render switchRow(
								'hide_text_window_on_blur',
								'hide-draft-on-blur',
								m.settings_hide_draft_on_blur(),
								view.hideTextWindowOnBlur,
								'set_hide_draft_on_blur'
							)}
							{@render switchRow(
								'show_text_window_buttons',
								'show-draft-buttons',
								m.settings_draft_buttons(),
								view.showTextWindowButtons,
								'set_show_draft_buttons'
							)}
							<SettingsRow modified={modifiedName(view, 'text_history_size')}>
								<Field.Field orientation="horizontal" class="min-h-8">
									<div class="flex-auto">
										<Field.Label class="inline" for="draft-history-size"
											>{m.settings_draft_history_size()}</Field.Label
										>
										{@render syncSetting('text_history_size', m.settings_draft_history_size())}
									</div>
									<Input
										id="draft-history-size"
										type="number"
										class="w-20 text-sm"
										min={0}
										max={MAX_DRAFT_HISTORY_SIZE}
										bind:value={historySizeInput}
										onchange={commitHistorySize}
									/>
								</Field.Field>
								<Button variant="destructive" size="sm" class="mt-2 w-fit" onclick={clearHistory}
									><Trash2Icon data-icon="inline-start" />{m.settings_draft_history_clear()}</Button
								>
							</SettingsRow>
						</SettingsSection>
						<SettingsSection title={m.settings_section_appearance()}>
							<SettingsRow modified={modifiedName(view, 'language')}>
								<Field.Field orientation="horizontal" class="flex-wrap">
									<div class="flex flex-auto items-center gap-1">
										<Field.Title id="language">{m.settings_language()}</Field.Title>
										{@render syncSetting('language', m.settings_language())}
									</div>
									<!-- 選択中の項目を押すと空になるので、空は無視して今の設定のまま表示する -->
									<ToggleGroup.Root
										type="single"
										variant="outline"
										aria-labelledby="language"
										bind:value={
											() => view.language,
											(language) => {
												if (language) run('set_language', { language });
											}
										}
									>
										{#each LANGUAGES as { value, name, lang } (value)}
											<ToggleGroup.Item {value} {lang}>{name()}</ToggleGroup.Item>
										{/each}
									</ToggleGroup.Root>
								</Field.Field>
							</SettingsRow>
							<SettingsRow modified={modifiedName(view, 'theme')}>
								<Field.Field orientation="horizontal" class="flex-wrap">
									<div class="flex flex-auto items-center gap-1">
										<Field.Title id="theme">{m.settings_theme()}</Field.Title>
										{@render syncSetting('theme', m.settings_theme())}
									</div>
									<ToggleGroup.Root
										type="single"
										variant="outline"
										aria-labelledby="theme"
										bind:value={
											() => view.theme,
											(theme) => {
												if (theme) run('set_theme', { theme });
											}
										}
									>
										{#each THEMES as { value, name } (value)}
											<ToggleGroup.Item {value}>{name()}</ToggleGroup.Item>
										{/each}
									</ToggleGroup.Root>
								</Field.Field>
							</SettingsRow>
						</SettingsSection>
					</div>
				</Tabs.Content>
				<Tabs.Content value="keys">
					<SettingsSection>
						<!-- 説明文は、題名と操作の行の下に全幅で置く -->
						{#if view.hotkeyByDesktop}
							<SettingsRow>
								{#if view.desktopHotkey}
									<!-- portal で付けたキーは、Mawok からは変えられない。デスクトップの割り当ての画面を開く -->
									<Field.Field orientation="horizontal" class="flex-wrap">
										<Field.Title class="shrink-0">{m.settings_hotkey()}</Field.Title>
										{#if view.desktopHotkeyKeys}
											<span class="ml-auto"
												><KeyCaps key={view.desktopHotkeyKeys} platform={view.platform} /></span
											>
										{:else}
											<span class="ml-auto text-sm">{view.desktopHotkey}</span>
										{/if}
										{#if view.desktopHotkeyConfigurable}
											<Button
												variant="outline"
												size="sm"
												onclick={() => invoke('configure_desktop_hotkey')}
											>
												{m.settings_hotkey_configure_desktop()}
											</Button>
										{/if}
									</Field.Field>
									{#if !view.desktopHotkeyConfigurable}
										<Field.Description class="leading-snug">
											{m.settings_hotkey_change_in_desktop()}
										</Field.Description>
									{/if}
								{:else}
									<Field.Field>
										<Field.Title>{m.settings_hotkey()}</Field.Title>
										<Field.Description class="leading-snug">
											{m.settings_hotkey_by_desktop()}
										</Field.Description>
										<code class="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-sm select-all"
											>mawok --toggle</code
										>
									</Field.Field>
								{/if}
							</SettingsRow>
						{:else}
							<SettingsRow modified={modifiedName(view, 'hotkey')}>
								<Field.Field orientation="horizontal" class="flex-wrap">
									<Field.Title class="shrink-0">{m.settings_hotkey()}</Field.Title>
									{#if recording === 'hotkey'}
										<div class="ml-auto">
											{@render keyRecordingStatus(
												view.hotkey,
												view.defaultHotkey,
												() => setHotkey(view.defaultHotkey),
												() => setHotkey('')
											)}
										</div>
									{:else}
										{@render keyButton(
											'hotkey',
											view.hotkey,
											m.settings_hotkey_change_label({
												key: view.hotkey
													? formatKeys(view.hotkey, view.platform)
													: m.settings_key_none()
											}),
											'px-1.5'
										)}
									{/if}
								</Field.Field>
								{#if recording === 'hotkey'}
									<Field.Description class="leading-snug">
										{m.settings_hotkey_recording_description()}
									</Field.Description>
								{/if}
								{#if hotkeyError}
									<Field.Error>{hotkeyError}</Field.Error>
								{/if}
							</SettingsRow>
						{/if}
						<SettingsRow>
							<!-- 1行が1つの操作。割り当てられなかった理由は、その行から離れないよう行と一緒に包む -->
							<div class="flex flex-col gap-2">
								{#each DRAFT_ACTIONS_IN_SETTINGS as action (action)}
									{@const key = view.textWindowKeys[action]}
									{@const label = draftActionLabel(action)}
									{@const modified = modifiedName(view, `text_window_keys.${action}`)}
									<div class="relative flex flex-col gap-0.5" data-modified={modified}>
										{#if modified}
											<SettingsModifiedMark class="inset-y-0 -left-4" />
										{/if}
										<!--
											狭い窓では、操作の名前を細かく折り返さず、キーとボタンを次の行の右端へ送る。
											キーの表示（Ctrl Shift Backspace など）が長く、横に並べると名前が1文字ずつ折れたり、はみ出したりするため
										-->
										<Field.Field orientation="horizontal" class="flex-wrap">
											<Field.Label class="min-w-36">{label}</Field.Label>
											{#if recording === action}
												<div class="ml-auto">
													{@render keyRecordingStatus(
														key,
														view.defaultDraftKeys[action],
														() => resetDraftKey(action),
														() => clearDraftKey(action)
													)}
												</div>
											{:else}
												{@render keyButton(
													action,
													key,
													m.settings_key_change({
														action: label,
														key: key ? formatKeys(key, view.platform) : m.settings_key_none()
													}),
													'ml-auto shrink-0 px-1.5'
												)}
											{/if}
										</Field.Field>
										{#if keyError?.action === action}
											<Field.Error>{keyError.message}</Field.Error>
										{/if}
										{#if recording === action}
											<Field.Description class="leading-snug">
												{m.settings_keys_recording_description()}
											</Field.Description>
										{/if}
									</div>
								{/each}
							</div>
						</SettingsRow>
					</SettingsSection>
				</Tabs.Content>
				<Tabs.Content value="draft">
					<SettingsSection>
						<SettingsRow modified={modifiedName(view, 'text_font')}>
							<div class="flex items-center gap-1">
								<Field.Label for="draft-font-family">{m.settings_draft_font()}</Field.Label>
								{@render syncSetting('text_font_family', m.settings_draft_font())}
							</div>
							<!-- 入力欄の文字の大きさは class で決め打ちする。部品の既定はウィンドウの幅 768px で切り替わり、広げる途中で小さくなるため（辞書の欄も同じ） -->
							<div class="flex flex-wrap gap-2">
								<Input
									id="draft-font-family"
									class="min-w-40 flex-1 text-sm"
									bind:value={
										() => fontFamily,
										(value) => {
											fontFamily = value;
											saveFont();
										}
									}
								/>
								<div class="flex items-center gap-1">
									<span
										id="draft-font-size-label"
										class="text-xs whitespace-nowrap text-muted-foreground"
										>{m.settings_draft_font_size()}</span
									>
									{@render syncSetting('text_font_size', m.settings_draft_font_size())}
									<Input
										id="draft-font-size"
										type="number"
										class="w-20 text-sm"
										aria-labelledby="draft-font-size-label"
										min={MIN_DRAFT_FONT_SIZE}
										max={MAX_DRAFT_FONT_SIZE}
										bind:value={
											() => fontSize,
											(value) => {
												// 空にした途中の状態では保存しない
												const size = Number(value);
												if (!Number.isFinite(size) || size <= 0) return;
												// 画面側でも範囲に収める。Rust 側も収めるが、そちらだけだと画面の表示と実際の値がずれたまま残る。
												// 整数でない値や u16 に収まらない値は、そもそも invoke が受け取れずに保存が落ちる
												fontSize = clamp(
													Math.round(size),
													MIN_DRAFT_FONT_SIZE,
													MAX_DRAFT_FONT_SIZE
												);
												saveFont();
											}
										}
									/>
								</div>
							</div>
							<Field.Description class="leading-snug">
								{m.settings_draft_font_description()}
							</Field.Description>
						</SettingsRow>
						<SettingsRow modified={modifiedName(view, 'text_color')}>
							<Field.Title>{m.settings_draft_text_color()}</Field.Title>
							<!-- 行の間は置き換え辞書と揃える。読めない値の知らせは、その行から離れないよう行と一緒に包む -->
							<div class="flex flex-col gap-2">
								{#each textColorRows as row (row.theme)}
									<div class="flex flex-col gap-0.5">
										<Field.Field orientation="horizontal" class="flex-wrap">
											<div class="flex-auto">
												<Field.Label
													for="draft-text-color-{row.theme}"
													class="inline whitespace-nowrap"
												>
													{row.label()}
												</Field.Label>
												{@render syncSetting(`text_color_${row.theme}`, row.label())}
											</div>
											<!-- 色見本は #rrggbb しか扱えないので、既定のときは標準の色を見せる -->
											<input
												type="color"
												class="h-8 w-10 flex-none cursor-pointer rounded-lg border border-input bg-transparent p-1"
												aria-label={row.pickLabel()}
												bind:value={
													() => textColors[row.theme] || DEFAULT_TEXT_COLORS[row.theme],
													(value) => setTextColor(row.theme, value)
												}
											/>
											<Input
												id="draft-text-color-{row.theme}"
												class="w-28 flex-none font-mono text-sm"
												spellcheck="false"
												aria-invalid={textColorErrors[row.theme] !== ''}
												onblur={() => showDefaultTextColor(row.theme)}
												bind:value={
													() => textColorInputs[row.theme],
													(value) => setTextColor(row.theme, String(value ?? ''))
												}
											/>
										</Field.Field>
										{#if textColorErrors[row.theme]}
											<Field.Error>{textColorErrors[row.theme]}</Field.Error>
										{/if}
									</div>
								{/each}
							</div>
						</SettingsRow>
						<SettingsRow modified={modifiedName(view, 'input_guidance')}>
							<!-- ほかの行のボタンと同じ高さにして、説明文までの間隔を揃える -->
							<Field.Field orientation="horizontal" class="min-h-8">
								<div class="flex-auto">
									<Field.Label class="inline" for="draft-guidance"
										>{m.settings_draft_guidance()}</Field.Label
									>
									{@render syncSetting('input_guidance', m.settings_draft_guidance())}
								</div>
								<!-- 既定のままなら戻すものがないので押せなくする -->
								<Button variant="outline" disabled={guidance === null} onclick={resetGuidance}>
									{m.settings_draft_guidance_reset()}
								</Button>
							</Field.Field>
							<Textarea
								id="draft-guidance"
								class="min-h-24 text-sm"
								bind:value={
									() => guidanceText,
									(value) => {
										// 書き換えたら自分の文になる。空にしたら、既定には戻さず「出さない」になる
										guidance = value ?? '';
										saveGuidance();
									}
								}
							/>
						</SettingsRow>
					</SettingsSection>
				</Tabs.Content>
				<Tabs.Content value="copy">
					<SettingsSection>
						{@render switchRow(
							'trim_trailing_whitespace',
							'trim-trailing',
							m.settings_trim_trailing(),
							view.trimTrailingWhitespace,
							'set_trim_trailing_whitespace'
						)}
						{@render switchRow(
							'exclude_from_clipboard_history',
							'exclude-history',
							m.settings_exclude_history(),
							view.excludeFromClipboardHistory,
							'set_exclude_from_clipboard_history',
							m.settings_exclude_history_description()
						)}
						<SettingsRow modified={modifiedName(view, 'char_width')}>
							<Field.Title>{m.settings_char_width()}</Field.Title>
							<!-- 句読点は幅でなく形を選ぶ。「、。」と「，．」はどちらも全角で、「、。」にはふつうに使う半角が無いため -->
							<Field.Field orientation="horizontal" class="flex-wrap justify-between">
								<div class="flex items-center gap-1">
									<span id="char-width-punctuation" class="text-sm"
										>{m.settings_char_width_punctuation()}</span
									>
									{@render syncSetting('punctuation_style', m.settings_char_width_punctuation())}
								</div>
								<ToggleGroup.Root
									type="single"
									variant="outline"
									aria-labelledby="char-width-punctuation"
									bind:value={
										() => view.punctuationStyle,
										(style) => {
											if (style) run('set_punctuation_style', { style });
										}
									}
								>
									{#each PUNCTUATION_STYLES as { value, name, lang } (value)}
										<ToggleGroup.Item {value} {lang}>{name()}</ToggleGroup.Item>
									{/each}
								</ToggleGroup.Root>
							</Field.Field>
							{#each CHAR_WIDTH_KINDS as row (row.kind)}
								<Field.Field orientation="horizontal" class="flex-wrap justify-between">
									<div class="flex items-center gap-1">
										<span id="char-width-{row.kind}" class="text-sm">{row.label()}</span>
										{@render syncSetting(`${row.kind}_width`, row.label())}
									</div>
									<ToggleGroup.Root
										type="single"
										variant="outline"
										aria-labelledby="char-width-{row.kind}"
										bind:value={
											() => view.charWidths[row.kind],
											(style) => {
												if (style)
													run('set_char_widths', {
														widths: { ...view.charWidths, [row.kind]: style }
													});
											}
										}
									>
										{#each row.styles as { value, name } (value)}
											<ToggleGroup.Item {value}>{name()}</ToggleGroup.Item>
										{/each}
									</ToggleGroup.Root>
								</Field.Field>
							{/each}
						</SettingsRow>
						<SettingsRow>
							<Field.Field orientation="horizontal" class="min-h-8">
								<Field.Title>{m.settings_replacements()}</Field.Title>
							</Field.Field>
							{#if view.proAvailable && !view.syncKinds.replacements}
								<SettingsSyncNote text={m.settings_sync_replacements_off()} />
							{/if}
							{#if showsFilter(replacements.rows.length, replacementFilter)}
								<ListFilter
									label={m.settings_replacements_filter()}
									bind:value={replacementFilter}
								/>
							{/if}
							{#if replacementMatches !== null && shownReplacements.length === 0}
								<p class="px-1 text-sm text-muted-foreground">{m.settings_filter_no_match()}</p>
							{:else if shownReplacements.length > 0}
								<!-- 1行が1件。並び順は登録した順で、画面では入れ替えられない -->
								<div class="flex flex-col gap-2">
									{#each shownReplacements as replacement (replacement.key)}
										<div id="replacement-{replacement.key}" class="flex items-center gap-2">
											<Input
												class="text-sm"
												aria-label={m.settings_replacements_from()}
												bind:value={
													() => replacement.from,
													(from) => {
														replacement.from = from;
														replacements.save();
													}
												}
											/>
											<ArrowRightIcon class="shrink-0 text-muted-foreground" aria-hidden="true" />
											<Input
												class="text-sm"
												aria-label={m.settings_replacements_to()}
												bind:value={
													() => replacement.to,
													(to) => {
														replacement.to = to;
														replacements.save();
													}
												}
											/>
											<Switch
												aria-label={m.settings_replacements_enabled()}
												bind:checked={
													() => replacement.enabled,
													(enabled) => {
														replacement.enabled = enabled;
														replacements.save();
													}
												}
											/>
											{#if view.proAvailable && view.syncKinds.replacements}
												<SyncToggle
													pressed={replacement.sync}
													name={replacement.from}
													onchange={(sync) => {
														replacement.sync = sync;
														replacements.save();
													}}
												/>
											{/if}
											<Button
												variant="ghost"
												size="icon"
												aria-label={m.settings_replacements_remove()}
												onclick={() => replacements.remove(replacements.rows.indexOf(replacement))}
											>
												<Trash2Icon />
											</Button>
										</div>
									{/each}
								</div>
							{/if}
							<Button variant="outline" size="sm" class="mt-2 w-fit" onclick={addReplacement}>
								<PlusIcon data-icon="inline-start" />
								{m.settings_replacements_add()}
							</Button>
						</SettingsRow>
					</SettingsSection>
				</Tabs.Content>
				<Tabs.Content value="snippets">
					{#if category === 'snippets'}
						<SettingsSnippets {view} editor={snippetsEditor} />
					{/if}
				</Tabs.Content>
				<Tabs.Content value="ai">
					<!-- 開いたときだけ描く。キーがあるかの確認でキーチェーンの許可を求められうるため -->
					{#if category === 'ai'}
						<SettingsAi
							{view}
							call={callActions}
							model={aiModel}
							{mawokAccountStatus}
							onopenaccount={openAccount}
						/>
					{/if}
				</Tabs.Content>
				<Tabs.Content value="account">
					{#if category === 'account'}
						<div class="flex flex-col gap-5">
							<SettingsSection>
								<SettingsRow>
									<SettingsMawokAccount
										call={callActions}
										signedIn={view.mawokAccountSignedIn}
										status={mawokAccountStatus}
										proAvailable={view.proAvailable}
										onchanged={() => refreshMawokAccountStatus(true)}
									/>
								</SettingsRow>
							</SettingsSection>
							{#if view.proAvailable}
								<SettingsSync {view} call={callSettings} onfailure={showActionError} />
							{/if}
							{#if view.mawokAccountSignedIn}
								<SettingsMawokDevices call={callActions} />
							{/if}
						</div>
					{/if}
				</Tabs.Content>
				<Tabs.Content value="about">
					<SettingsSection>
						<!-- 更新は Mac 版だけが自分で行うので、Mac だけに出す（docs/platform.md「Mac 版の更新」） -->
						{#if view.platform === 'macos'}
							<SettingsUpdate call={callSettings} />
						{/if}
						<SettingsRow>
							<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
								<Field.Title>{m.settings_manual()}</Field.Title>
								<Button variant="outline" size="sm" onclick={() => run('open_manual_window')}>
									{m.settings_manual_show()}
								</Button>
							</Field.Field>
						</SettingsRow>
						<SettingsRow>
							<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
								<Field.Title>{m.settings_log()}</Field.Title>
								<Button
									variant="outline"
									size="sm"
									aria-label={{
										macos: m.settings_reveal_log_macos,
										windows: m.settings_reveal_log_windows,
										linux: m.settings_reveal_log_linux
									}[view.platform]()}
									onclick={() => run('reveal_log_file')}
								>
									{{
										macos: m.settings_reveal_macos,
										windows: m.settings_reveal_windows,
										linux: m.settings_reveal_linux
									}[view.platform]()}
								</Button>
							</Field.Field>
						</SettingsRow>
						<SettingsRow>
							<!-- 狭いときは、題名を折らずに操作を次の行へ回す -->
							<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
								<Field.Title>{m.settings_backup()}</Field.Title>
								<div class="flex items-center gap-2">
									<Button variant="outline" size="sm" onclick={backUp}>
										{m.settings_backup_now()}
									</Button>
									<Button
										variant="outline"
										size="sm"
										onclick={() => {
											backupNotice = '';
											backupOpen = true;
										}}
									>
										{m.settings_backup_restore_open()}
									</Button>
								</div>
							</Field.Field>
							{#if backupNotice}
								<Field.Description role="status">{backupNotice}</Field.Description>
							{/if}
						</SettingsRow>
						<SettingsRow>
							<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
								<Field.Title>{m.settings_licenses()}</Field.Title>
								<Button variant="outline" size="sm" onclick={() => run('open_licenses_window')}>
									{m.settings_licenses_show()}
								</Button>
							</Field.Field>
						</SettingsRow>
					</SettingsSection>
				</Tabs.Content>
				{#if error}
					<Alert.Root variant="destructive">
						<CircleAlertIcon />
						<Alert.Title>{error}</Alert.Title>
					</Alert.Root>
				{/if}
			</div>
		</Tabs.Root>
	</main>
	<BackupDialog bind:open={backupOpen} locale={view.locale} />
{/if}

<style>
	:global(.settings-page) {
		--muted-foreground: oklch(0.49 0 0);
	}

	:global(.dark .settings-page) {
		--muted-foreground: oklch(0.66 0 0);
	}

	:global(.settings-page [data-slot='field-description']) {
		font-size: 13px;
	}
</style>
