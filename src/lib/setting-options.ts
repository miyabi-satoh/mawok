import type { Language } from '$lib/bindings/Language';
import type { Theme } from '$lib/bindings/Theme';
import type { WidthStyle } from '$lib/bindings/WidthStyle';
import { m } from '$lib/paraglide/messages';
import type { CharWidths, PunctuationStyle } from '$lib/settings.svelte';

/** 設定の選択肢の1つ。lang は、名前が表示言語と違う言語のとき（読み上げと字形を合わせる） */
type Option<V extends string> = { value: V; name: () => string; lang?: 'ja' | 'en' };

/** 表示言語の選択肢。言語の名前はその言語で書くので、表示言語で変えない */
export const LANGUAGES: Option<Language>[] = [
	{ value: 'system', name: m.settings_language_system },
	{ value: 'ja', name: () => '日本語', lang: 'ja' },
	{ value: 'en', name: () => 'English', lang: 'en' }
];

export const THEMES: Option<Theme>[] = [
	{ value: 'system', name: m.settings_theme_system },
	{ value: 'light', name: m.settings_theme_light },
	{ value: 'dark', name: m.settings_theme_dark }
];

/** 句読点の揃え方の選択肢。記号そのものが選択肢なので、文言にはしない */
export const PUNCTUATION_STYLES: Option<PunctuationStyle>[] = [
	{ value: 'keep', name: m.settings_char_width_keep },
	{ value: 'kutouten', name: () => '、。', lang: 'ja' },
	{ value: 'comma', name: () => '，．', lang: 'ja' }
];

/** 全角・半角の揃え方の選択肢 */
export const WIDTH_STYLES: Option<WidthStyle>[] = [
	{ value: 'keep', name: m.settings_char_width_keep },
	{ value: 'full', name: m.settings_char_width_full },
	{ value: 'half', name: m.settings_char_width_half }
];

/** 全角・半角を揃える文字の種類と、選べる揃え方。カタカナは全角に揃えるだけ（Rust 側の KatakanaWidth） */
export const CHAR_WIDTH_KINDS: {
	kind: keyof CharWidths;
	label: () => string;
	styles: Option<WidthStyle>[];
}[] = [
	{ kind: 'alphabet', label: m.settings_char_width_alphabet, styles: WIDTH_STYLES },
	{ kind: 'digit', label: m.settings_char_width_digit, styles: WIDTH_STYLES },
	{ kind: 'space', label: m.settings_char_width_space, styles: WIDTH_STYLES },
	{ kind: 'symbol', label: m.settings_char_width_symbol, styles: WIDTH_STYLES },
	{
		kind: 'katakana',
		label: m.settings_char_width_katakana,
		styles: WIDTH_STYLES.filter(({ value }) => value !== 'half')
	}
];

/** 選択肢の表から、値の名前を引く */
export function optionName<V extends string>(options: Option<V>[], value: V): string {
	return options.find((option) => option.value === value)?.name() ?? value;
}
