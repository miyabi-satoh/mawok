import { newAction } from '$lib/action-target';
import type { DraftKeys } from '$lib/keys';
import type { Action, SettingsView } from '$lib/settings.svelte';

/** Rust 側の既定のキー（src-tauri/src/draft_keys.rs）の写し */
export const DEFAULT_DRAFT_KEYS: DraftKeys = {
	copy: 'CommandOrControl+Enter',
	send: 'CommandOrControl+Shift+Enter',
	settings: 'CommandOrControl+Comma',
	snippets: 'CommandOrControl+KeyJ',
	actions: 'CommandOrControl+KeyK',
	historyOlder: 'CommandOrControl+Alt+ArrowUp',
	historyNewer: 'CommandOrControl+Alt+ArrowDown',
	sendTargets: 'CommandOrControl+KeyL',
	insertReceived: 'CommandOrControl+KeyI',
	discardReceived: 'CommandOrControl+Shift+Backspace'
};

/** テストで Rust 側から届く設定。既定の値に overrides を重ねる */
export function settingsView(overrides: Partial<SettingsView> = {}): SettingsView {
	return {
		revision: 1,
		hotkey: 'CommandOrControl+Shift+Space',
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
		actions: [],
		pairedDevices: [],
		deviceName: 'desk-pc',
		version: '0.1.0',
		locale: 'ja',
		platform: 'macos',
		...overrides
	};
}

/** AI のアクションの1件 */
export function aiAction(name: string, instruction: string): Action {
	return newAction(name, `@ai ${instruction}`);
}
