import { errorCode } from '$lib/errors';
import { CONSTANTS } from '$lib/bindings/constants';
import type { DraftAction as GeneratedDraftAction } from '$lib/bindings/DraftAction';
import type { DraftKeys as GeneratedDraftKeys } from '$lib/bindings/DraftKeys';
import type { Platform as GeneratedPlatform } from '$lib/bindings/Platform';
import { m } from '$lib/paraglide/messages';

/** IME が処理したキーか（変換中の Enter や Esc など）。変換の操作なので、アプリのキーとしては扱わない */
export function isImeKey(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
	// IME が処理したキーは keyCode 229 で届く
	return event.isComposing || event.keyCode === 229;
}

/** 修飾キー（Cmd・Ctrl・Alt・Shift）をどれも押していないか */
export function hasNoModifiers(
	event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>
): boolean {
	return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

/**
 * 下書きをコピーせずに隠すキーか（Esc）。うっかり押しても書きかけとクリップボードを失わないよう、コピーする操作とは分ける。
 * IME の変換中の Esc は変換の取り消しなので対象外にする
 */
export function isDismissKey(
	event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>
): boolean {
	return event.key === 'Escape' && !isImeKey(event);
}

export type Platform = GeneratedPlatform;

/** 下書きウィンドウでキーで呼べる操作（Rust 側の draft_keys::DraftAction）。並びは、キーが重なったときに先の操作にキーを残す順 */
export const DRAFT_ACTIONS = CONSTANTS.DRAFT_ACTIONS satisfies readonly GeneratedDraftAction[];

/**
 * 設定画面に並べる順。下書きウィンドウのボタンの並び（上の行の履歴、下の列の左から右、届いた下書きの知らせ）に合わせる。
 * 重なったときの優先の順（DRAFT_ACTIONS）とは別に持つ
 */
export const DRAFT_ACTIONS_IN_SETTINGS = [
	'historyOlder',
	'historyNewer',
	'settings',
	'snippets',
	'actions',
	'changeFolder',
	'send',
	'sendTargets',
	'copy',
	'insertReceived',
	'discardReceived'
] as const satisfies readonly GeneratedDraftAction[];

export type DraftAction = GeneratedDraftAction;

/** 操作ごとのキー。ホットキーと同じ書き方で、空文字は割り当てなし。既定と重なりの決まりは Rust 側（src-tauri/src/draft_keys.rs）が持つ */
export type DraftKeys = GeneratedDraftKeys;

/**
 * 押したキーに割り当てた操作。なければ null。
 * IME の変換中は、変換の確定や取り消しを横取りしないよう対象外にする
 */
export function draftActionFor(
	event: Pick<
		KeyboardEvent,
		'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode'
	>,
	keys: DraftKeys,
	platform: Platform
): DraftAction | null {
	if (isImeKey(event)) return null;
	const accelerator = toDraftKey(event, platform);
	if (!accelerator) return null;
	return DRAFT_ACTIONS.find((action) => keys[action] === accelerator) ?? null;
}

/**
 * 押したキーを、下書きの操作のキーの書き方にする。ホットキーの書き方と同じだが、テンキーの Enter は Enter とする
 * （Rust 側の draft_keys::normalize と同じ。コピーの Cmd+Enter はテンキーの Enter でも効いていたため）
 */
export function toDraftKey(event: KeyCombo, platform: Platform): string | null {
	return toAccelerator(event, platform)?.replace(/\+NumpadEnter$/, '+Enter') ?? null;
}

/** 設定画面に出す操作の名前 */
export function draftActionLabel(action: DraftAction): string {
	return {
		copy: m.settings_key_copy,
		send: m.settings_key_send,
		settings: m.settings_key_settings,
		snippets: m.settings_key_snippets,
		actions: m.settings_key_actions,
		historyOlder: m.settings_key_historyOlder,
		historyNewer: m.settings_key_historyNewer,
		sendTargets: m.settings_key_sendTargets,
		insertReceived: m.settings_key_insertReceived,
		discardReceived: m.settings_key_discardReceived,
		changeFolder: m.settings_key_changeFolder
	}[action]();
}

/** ボタンの説明に、割り当てたキーを添える。割り当てがなければ説明だけ */
export function keyHint(label: string, key: string, platform: Platform): string {
	return key ? m.key_hint({ label, keys: formatKeys(key, platform) }) : label;
}

/**
 * キーを割り当てられなかった理由を、画面に出す文にする。Rust 側は理由を符号（draft_keys::Rejection::code）で返す。
 * 符号でなければ、受け取ったものをそのまま出す
 */
export function keyRejectionMessage(error: unknown, key: string, platform: Platform): string {
	const code = errorCode(error);
	const keys = formatKeys(key, platform);
	if (code === 'keys.editing') return m.settings_key_editing({ keys });
	if (code === 'keys.hotkey') return m.settings_key_used_by_hotkey({ keys });
	if (code === 'keys.invalid') return m.settings_key_invalid({ keys });
	const action = code.match(/^keys\.action\.(\w+)$/)?.[1];
	if (action && (DRAFT_ACTIONS as readonly string[]).includes(action)) {
		return m.settings_key_used_by_action({
			keys,
			action: draftActionLabel(action as DraftAction)
		});
	}
	return code;
}

/** 記号と矢印のキーは、名前ではなく刻印と同じ見た目にする。記号の位置は配列で変わるが、US 配列の刻印で出す */
const COMMON_LABELS: Record<string, string> = {
	Comma: ',',
	Period: '.',
	Slash: '/',
	Backslash: '\\',
	Semicolon: ';',
	Quote: "'",
	Backquote: '`',
	BracketLeft: '[',
	BracketRight: ']',
	Minus: '-',
	Equal: '=',
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→'
};

const LABELS: Record<Platform, Record<string, string>> = {
	macos: {
		...COMMON_LABELS,
		CommandOrControl: '⌘',
		Control: '⌃',
		Alt: '⌥',
		Shift: '⇧',
		Backspace: '⌫'
	},
	windows: {
		...COMMON_LABELS,
		CommandOrControl: 'Ctrl',
		Super: 'Win'
	}
};

/**
 * 設定・ライセンス・使い方のウィンドウを閉じるキーか。OS 標準の Cmd+W（Windows は Ctrl+W）と、このアプリで「閉じる」として
 * 定着している Esc の両方で閉じる。ホットキーの記録中の Esc は記録の中止なので、呼ぶ側で分ける
 */
export function isCloseWindowKey(
	event: Pick<
		KeyboardEvent,
		'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode'
	>,
	platform: Platform
): boolean {
	if (isImeKey(event)) return false;
	if (event.key === 'Escape') return hasNoModifiers(event);
	if (event.key.toLowerCase() !== 'w' || event.altKey || event.shiftKey) return false;
	return platform === 'macos' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * ウィンドウの URL の `?platform=` から OS を読む。設定と一緒に OS を受け取らないウィンドウ（ライセンス・使い方）に、
 * 開くときに Rust 側が付ける。読めなければ Windows とみなす
 */
export function platformFromUrl(url: URL): Platform {
	return url.searchParams.get('platform') === 'macos' ? 'macos' : 'windows';
}

/** ホットキーの設定の文字列を、画面に並べるキーの表示に分ける */
export function keyLabels(accelerator: string, platform: Platform): string[] {
	// 英字と数字のキーは KeyK → K、Digit1 → 1 のように、キーボードの刻印と同じ見た目にする
	return accelerator
		.split('+')
		.map((part) => LABELS[platform][part] ?? part.replace(/^(?:Key|Digit)(.)$/, '$1'));
}

/** キーの組み合わせを、文の中に書く形にする。macOS は記号を詰めて（⌘⇧Space）、Windows は + でつなぐ（Ctrl+Shift+Space） */
export function formatKeys(accelerator: string, platform: Platform): string {
	return keyLabels(accelerator, platform).join(platform === 'macos' ? '' : '+');
}

type KeyCombo = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

const MODIFIER_CODES = new Set([
	'MetaLeft',
	'MetaRight',
	'ControlLeft',
	'ControlRight',
	'AltLeft',
	'AltRight',
	'ShiftLeft',
	'ShiftRight'
]);

/** ホットキーとして登録できる KeyboardEvent.code。Rust 側が生成した集合を使う */
const SUPPORTED_CODES = new Set<string>(CONSTANTS.SUPPORTED_CODES);

/** 押したキーの組み合わせを、ホットキーの設定に書く文字列（例: CommandOrControl+Shift+Space）にする */
export function toAccelerator(event: KeyCombo, platform: Platform): string | null {
	// 修飾キーを押し始めただけのときは、本体のキーが押されるのを待つ
	if (MODIFIER_CODES.has(event.code)) return null;
	if (!SUPPORTED_CODES.has(event.code)) return null;
	const parts: string[] = [];
	// Mac の ⌘ と Windows の Ctrl は、どちらの OS でも同じ意味になる CommandOrControl として書く
	if (platform === 'macos' ? event.metaKey : event.ctrlKey) parts.push('CommandOrControl');
	if (platform === 'macos' && event.ctrlKey) parts.push('Control');
	if (platform === 'windows' && event.metaKey) parts.push('Super');
	if (event.altKey) parts.push('Alt');
	// Shift だけ（や修飾キーなし）では普段の文字の入力を奪うので、ほかの修飾キーを必須にする
	if (parts.length === 0) return null;
	if (event.shiftKey) parts.push('Shift');
	parts.push(event.code);
	return parts.join('+');
}
