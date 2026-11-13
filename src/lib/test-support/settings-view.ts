import type { DraftKeys } from '#lib/keys.ts';
import type { SettingsView } from '#lib/settings.svelte.ts';

/** Rust 側の既定のキー（src-tauri/src/draft_keys.rs）の写し */
export const DEFAULT_DRAFT_KEYS: DraftKeys = {
	copy: 'CommandOrControl+Enter',
	settings: 'CommandOrControl+Comma',
	snippets: 'CommandOrControl+KeyK',
	historyOlder: 'CommandOrControl+Alt+ArrowUp',
	historyNewer: 'CommandOrControl+Alt+ArrowDown',
	historySearch: 'CommandOrControl+KeyR',
	new: 'CommandOrControl+KeyN',
	delete: ''
};

/** テストで Rust 側から届く設定。既定の値に overrides を重ねる */
export function settingsView(overrides: Partial<SettingsView> = {}): SettingsView {
	return {
		revision: 1,
		hotkey: 'CommandOrControl+Shift+Space',
		modifiedSettings: [],
		textWindowKeys: { ...DEFAULT_DRAFT_KEYS },
		defaultDraftKeys: DEFAULT_DRAFT_KEYS,
		defaultHotkey: 'CommandOrControl+Shift+Space',
		hotkeyByDesktop: false,
		desktopHotkey: null,
		desktopHotkeyKeys: null,
		desktopHotkeyConfigurable: false,
		autostart: true,
		language: 'system',
		theme: 'system',
		textWindowAlwaysOnTop: true,
		hideTextWindowOnBlur: true,
		showTextWindowButtons: true,
		textWindowDisplay: 'last',
		clearTextAfter: 'never',
		textHistorySize: 10_000,
		trimTrailingWhitespace: true,
		excludeFromClipboardHistory: true,
		replacements: [],
		snippets: [],
		punctuationStyle: 'keep',
		charWidths: {
			alphabet: 'keep',
			digit: 'keep',
			space: 'keep',
			symbol: 'keep',
			katakana: 'keep'
		},
		textFontFamily: '',
		textFontSize: 16,
		textColorLight: '',
		textColorDark: '',
		inputGuidance: null,
		settingsDir: '/Users/me/Library/Application Support/com.amiiby.mawok',
		settingsDirIsDefault: true,
		settingsProblem: null,
		hotkeyUnavailable: false,
		autostartFailed: null,
		version: '0.1.0',
		locale: 'ja',
		platform: 'macos',
		...overrides
	};
}
