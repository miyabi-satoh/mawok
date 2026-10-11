import { describe, expect, it } from 'vitest';
import type { SyncConflict } from '$lib/bindings/SyncConflict';
import type { SyncValue } from '$lib/bindings/SyncValue';
import { DEFAULT_TEXT_COLORS } from '$lib/color';
import { m } from '$lib/paraglide/messages';
import type { Action, Replacement, Snippet } from '$lib/settings.svelte';
import { DEFAULT_DRAFT_KEYS } from '$lib/test-support/settings-view';
import { choiceText, fromDifference, sideName, syncSettingLabel } from './sync-choices';

function conflict(thisDevice: SyncValue, otherDevice: SyncValue): SyncConflict {
	return { id: 's_item', seq: 2, thisDevice, otherDevice };
}

const text = (thisDevice: SyncValue, otherDevice: SyncValue, platform = 'macos' as const) =>
	choiceText(conflict(thisDevice, otherDevice), platform);

const pair = (label: string, value: string) => m.sync_choice_pair({ label, value });

const widths = {
	alphabet: 'keep',
	digit: 'keep',
	space: 'keep',
	symbol: 'keep',
	katakana: 'keep'
} as const;

const replacement: Replacement = {
	id: 'a',
	from: '濃度',
	to: 'Node.js',
	enabled: true,
	sync: true
};
const snippet: Snippet = {
	id: 'b',
	name: '挨拶',
	body: 'お世話になっております。\n佐藤です。',
	sync: true
};
const action: Action = {
	id: 'c',
	name: '英訳',
	command: '@ai 英語に訳す',
	output: 'replace',
	encoding: 'utf-8',
	enabled: true,
	sync: true
};

describe('syncSettingLabel', () => {
	it('食い違いを選ぶ画面と同じ設定名を使い、知らない名前はそのまま出す', () => {
		expect(syncSettingLabel('theme')).toBe(m.settings_theme());
		expect(syncSettingLabel('text_font_family')).toBe(m.settings_draft_font());
		expect(syncSettingLabel('unknown_setting')).toBe('unknown_setting');
	});
});

/**
 * 同期する設定の項目（docs/sync.md「同期する単位」）ごとの、名前と値の言い方。
 * 行は [種類, このデバイスの値, ほかのデバイスの値, 名前, このデバイスの言い方, ほかのデバイスの言い方]
 */
const SETTINGS: [string, unknown, unknown, string, string, string][] = [
	['language', 'ja', 'system', m.settings_language(), '日本語', m.settings_language_system()],
	['theme', 'dark', 'light', m.settings_theme(), m.settings_theme_dark(), m.settings_theme_light()],
	[
		'text_window_always_on_top',
		true,
		false,
		m.settings_draft_always_on_top(),
		m.sync_choice_on(),
		m.sync_choice_off()
	],
	[
		'hide_text_window_on_blur',
		false,
		true,
		m.settings_hide_draft_on_blur(),
		m.sync_choice_off(),
		m.sync_choice_on()
	],
	[
		'show_text_window_buttons',
		true,
		false,
		m.settings_draft_buttons(),
		m.sync_choice_on(),
		m.sync_choice_off()
	],
	['text_history_size', 50, 0, m.settings_draft_history_size(), '50', '0'],
	[
		'trim_trailing_whitespace',
		true,
		false,
		m.settings_trim_trailing(),
		m.sync_choice_on(),
		m.sync_choice_off()
	],
	[
		'punctuation_style',
		'kutouten',
		'keep',
		m.sync_choice_label_sub({
			group: m.settings_char_width(),
			item: m.settings_char_width_punctuation()
		}),
		'、。',
		m.settings_char_width_keep()
	],
	[
		'char_widths',
		{ ...widths, alphabet: 'half', katakana: 'full' },
		{ ...widths, alphabet: 'full' },
		m.settings_char_width(),
		[
			pair(m.settings_char_width_alphabet(), m.settings_char_width_half()),
			pair(m.settings_char_width_katakana(), m.settings_char_width_full())
		].join('\n'),
		[
			pair(m.settings_char_width_alphabet(), m.settings_char_width_full()),
			pair(m.settings_char_width_katakana(), m.settings_char_width_keep())
		].join('\n')
	],
	[
		'exclude_from_clipboard_history',
		true,
		false,
		m.settings_exclude_history(),
		m.sync_choice_on(),
		m.sync_choice_off()
	],
	['text_font_size', 16, 20, m.settings_draft_font_size(), '16', '20'],
	[
		'text_color_light',
		'#112233',
		'',
		m.sync_choice_label_sub({
			group: m.settings_draft_text_color(),
			item: m.settings_draft_text_color_light()
		}),
		'#112233',
		DEFAULT_TEXT_COLORS.light
	],
	[
		'text_color_dark',
		'',
		'#ddeeff',
		m.sync_choice_label_sub({
			group: m.settings_draft_text_color(),
			item: m.settings_draft_text_color_dark()
		}),
		DEFAULT_TEXT_COLORS.dark,
		'#ddeeff'
	],
	[
		'input_guidance',
		null,
		'ここに書く',
		m.settings_draft_guidance(),
		m.sync_choice_default(),
		'ここに書く'
	],
	['ai_service', 'none', 'gemini', m.settings_ai_service(), m.settings_ai_service_none(), 'Gemini'],
	[
		'ai_models',
		{ gemini: 'gemini-a', openai: 'gpt-a' },
		{ gemini: 'gemini-a' },
		m.settings_ai_model(),
		pair('OpenAI', 'gpt-a'),
		pair('OpenAI', m.sync_choice_default())
	],
	[
		'hotkey',
		'CommandOrControl+Shift+Space',
		'',
		m.settings_hotkey(),
		'⌘⇧Space',
		m.settings_key_none()
	],
	[
		'text_window_keys',
		{ ...DEFAULT_DRAFT_KEYS, copy: 'CommandOrControl+KeyP' },
		{ ...DEFAULT_DRAFT_KEYS, copy: '' },
		m.settings_category_keys(),
		pair(m.settings_key_copy(), '⌘P'),
		pair(m.settings_key_copy(), m.settings_key_none())
	],
	['text_font_family', 'Menlo', '', m.settings_draft_font(), 'Menlo', m.sync_choice_default()]
];

describe('choiceText', () => {
	it.each(SETTINGS)(
		'%s を、設定の画面のラベルと値の言い方で出す',
		(type, mine, theirs, label, thisDevice, otherDevice) => {
			const side = (value: unknown) => ({ type, value }) as SyncValue;
			expect(text(side(mine), side(theirs))).toEqual({ label, thisDevice, otherDevice });
		}
	);

	it('同期する設定の項目を、どれも見ている', () => {
		// SyncValue の種類のうち、行と「削除」を除いたもの。足したら、上の表にも足す
		const types: Record<
			Exclude<SyncValue['type'], 'replacement' | 'snippet' | 'action' | 'deleted'>,
			true
		> = {
			language: true,
			theme: true,
			text_window_always_on_top: true,
			hide_text_window_on_blur: true,
			show_text_window_buttons: true,
			text_history_size: true,
			trim_trailing_whitespace: true,
			punctuation_style: true,
			char_widths: true,
			exclude_from_clipboard_history: true,
			text_font_size: true,
			text_color_light: true,
			text_color_dark: true,
			input_guidance: true,
			ai_service: true,
			ai_models: true,
			hotkey: true,
			text_window_keys: true,
			text_font_family: true
		};
		expect(SETTINGS.map(([type]) => type).sort()).toEqual(Object.keys(types).sort());
	});

	it('キーは、開いた OS の表示で出す', () => {
		const hotkey = (value: string): SyncValue => ({ type: 'hotkey', value });
		expect(
			text(hotkey('CommandOrControl+Shift+Space'), hotkey('Alt+KeyK'), 'windows' as never)
		).toMatchObject({ thisDevice: 'Ctrl+Shift+Space', otherDevice: 'Alt+K' });
	});

	it('入力欄の案内を空にした値は、既定と見分けて出す', () => {
		const guidance = (value: string | null): SyncValue => ({ type: 'input_guidance', value });
		expect(text(guidance(''), guidance(null))).toMatchObject({
			thisDevice: m.sync_choice_empty(),
			otherDevice: m.sync_choice_default()
		});
	});

	it('置き換え辞書の行は、種類と置き換える前の文字列を名前にし、片方で消した行は「削除」と出す', () => {
		expect(text({ type: 'replacement', value: replacement }, { type: 'deleted' })).toEqual({
			label: m.sync_choice_row_replacement({ name: '濃度' }),
			thisDevice: '濃度 → Node.js',
			otherDevice: m.sync_choice_deleted()
		});
	});

	it('このデバイスで消した行は、ほかのデバイスの行から名前を付ける', () => {
		expect(text({ type: 'deleted' }, { type: 'snippet', value: snippet })).toEqual({
			label: m.sync_choice_row_snippet({ name: '挨拶' }),
			thisDevice: m.sync_choice_deleted(),
			otherDevice: '挨拶\nお世話になっております。\n佐藤です。'
		});
	});

	it('名前の無い定型文は、本文の最初の行を名前にする', () => {
		const unnamed = { ...snippet, name: '' };
		expect(text({ type: 'snippet', value: unnamed }, { type: 'deleted' }).label).toBe(
			m.sync_choice_row_snippet({ name: 'お世話になっております。' })
		);
	});

	it('行のオン・オフだけが違うときは、その違いを添える', () => {
		const off = { ...replacement, enabled: false };
		expect(
			text({ type: 'replacement', value: replacement }, { type: 'replacement', value: off })
		).toMatchObject({
			thisDevice: `濃度 → Node.js\n${pair(m.settings_replacements_enabled(), m.sync_choice_on())}`,
			otherDevice: `濃度 → Node.js\n${pair(m.settings_replacements_enabled(), m.sync_choice_off())}`
		});
	});

	it('アクションは、名前とコマンドに、違っている項目だけを添える', () => {
		const theirs: Action = { ...action, output: 'insert', encoding: 'shift_jis', enabled: false };
		expect(text({ type: 'action', value: action }, { type: 'action', value: theirs })).toEqual({
			label: m.sync_choice_row_action({ name: '英訳' }),
			thisDevice: [
				'英訳',
				'@ai 英語に訳す',
				pair(m.settings_actions_output(), m.settings_actions_output_replace()),
				pair(m.settings_actions_encoding(), 'UTF-8'),
				pair(m.settings_actions_enabled_unnamed(), m.sync_choice_on())
			].join('\n'),
			otherDevice: [
				'英訳',
				'@ai 英語に訳す',
				pair(m.settings_actions_output(), m.settings_actions_output_insert()),
				pair(m.settings_actions_encoding(), 'Shift_JIS'),
				pair(m.settings_actions_enabled_unnamed(), m.sync_choice_off())
			].join('\n')
		});
	});
});

describe('choiceText の長い値', () => {
	const body = (...lines: string[]): SyncValue => ({
		type: 'snippet',
		value: { ...snippet, name: '', body: lines.join('\n') }
	});

	it('後ろだけが違う本文は、違いが始まる行の1行前から出す', () => {
		expect(text(body('1', '2', '3', '4', 'here'), body('1', '2', '3', '4', 'there'))).toMatchObject(
			{
				thisDevice: '…\n4\nhere',
				otherDevice: '…\n4\nthere'
			}
		);
	});

	it('片方で消した行は、残っている方を先頭から出す', () => {
		expect(text(body('1', '2', '3'), { type: 'deleted' })).toMatchObject({
			thisDevice: '1\n2\n3',
			otherDevice: m.sync_choice_deleted()
		});
	});

	it('入力欄の案内も、違いが始まる行の1行前から出す', () => {
		const guidance = (value: string): SyncValue => ({ type: 'input_guidance', value });
		expect(text(guidance('a\nb\nc\nd'), guidance('a\nb\nc\ne'))).toMatchObject({
			thisDevice: '…\nc\nd',
			otherDevice: '…\nc\ne'
		});
	});
});

describe('fromDifference', () => {
	it('先頭の行が違えば、略さない', () => {
		expect(fromDifference('a\nb\nc', 'x\nb\nc')).toEqual(['a\nb\nc', 'x\nb\nc']);
	});

	it('2行目が違うときも、1行前が先頭なので略さない', () => {
		expect(fromDifference('a\nb', 'a\nx')).toEqual(['a\nb', 'a\nx']);
	});

	it('略して減るのが1行だけなら、略さない', () => {
		expect(fromDifference('a\nb\nc', 'a\nb\nx')).toEqual(['a\nb\nc', 'a\nb\nx']);
	});

	it('末尾が違えば、その1行前から出し、略した印を先頭に置く', () => {
		expect(fromDifference('a\nb\nc\nd', 'a\nb\nc\nx')).toEqual(['…\nc\nd', '…\nc\nx']);
	});

	it('片方が長いときは、短い方の最後の行から出す', () => {
		expect(fromDifference('a\nb\nc\nd\ne', 'a\nb\nc')).toEqual(['…\nc\nd\ne', '…\nc']);
	});

	it('同じ値は、そのまま出す', () => {
		expect(fromDifference('a\nb\nc', 'a\nb\nc')).toEqual(['a\nb\nc', 'a\nb\nc']);
	});
});

describe('sideName', () => {
	it.each([
		['this_device', m.sync_choice_this_device()],
		['other_device', m.sync_choice_other_device()],
		['later', m.sync_choice_later()]
	] as const)('%s の読み上げの名前に、項目の名前を入れる', (side, name) => {
		expect(sideName(m.settings_theme(), side)).toBe(
			m.sync_choice_side_of({ name: m.settings_theme(), side: name })
		);
	});
});
