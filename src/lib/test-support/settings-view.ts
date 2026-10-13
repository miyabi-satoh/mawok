import type { DraftKeys } from '$lib/keys';
import type { SettingsView, Snippet } from '$lib/settings.svelte';
import { newSnippet } from '$lib/snippets';

/** Rust 側の既定のキー（src-tauri/src/draft_keys.rs）の写し */
export const DEFAULT_DRAFT_KEYS: DraftKeys = {
	copy: 'CommandOrControl+Enter',
	send: 'CommandOrControl+Shift+Enter',
	settings: 'CommandOrControl+Comma',
	snippets: 'CommandOrControl+KeyK',
	historyOlder: 'CommandOrControl+Alt+ArrowUp',
	historyNewer: 'CommandOrControl+Alt+ArrowDown',
	sendTargets: 'CommandOrControl+KeyL',
	insertReceived: 'CommandOrControl+KeyI',
	discardReceived: 'CommandOrControl+Shift+Backspace',
	changeFolder: 'CommandOrControl+KeyD'
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
		autostart: true,
		language: 'system',
		theme: 'system',
		textWindowAlwaysOnTop: true,
		hideTextWindowOnBlur: true,
		showTextWindowButtons: true,
		textHistorySize: 50,
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
		aiService: 'none',
		aiConsent: null,
		aiModels: {},
		defaultAiModels: {
			gemini: 'gemini-3.5-flash-lite',
			anthropic: 'claude-haiku-4-5',
			openai: 'gpt-5.4-nano'
		},
		devices: [],
		deviceName: 'desk-pc',
		proAvailable: false,
		sharedKeyStatus: 'none',
		mawokAccountSignedIn: false,
		syncKinds: {
			settings: true,
			keys: true,
			replacements: true,
			snippets: true,
			history: true
		},
		syncExcludedSettings: [],
		syncConflicts: 0,
		version: '0.1.0',
		locale: 'ja',
		platform: 'macos',
		...overrides
	};
}

/** AI に頼む定型文の1件 */
export function aiSnippet(name: string, instruction: string): Snippet {
	return newSnippet(name, `@ai ${instruction}`);
}
