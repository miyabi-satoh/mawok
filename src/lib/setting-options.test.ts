import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { CHAR_WIDTH_KINDS, LANGUAGES, optionName, THEMES, WIDTH_STYLES } from './setting-options';

describe('設定の選択肢', () => {
	it('値の名前を、表から引く', () => {
		expect(optionName(THEMES, 'dark')).toBe(m.settings_theme_dark());
		expect(optionName(LANGUAGES, 'ja')).toBe('日本語');
		expect(optionName(WIDTH_STYLES, 'half')).toBe(m.settings_char_width_half());
	});

	it('カタカナだけは、半角に揃える選択肢を持たない', () => {
		const styles = (kind: string) =>
			CHAR_WIDTH_KINDS.find((row) => row.kind === kind)?.styles.map(({ value }) => value);
		expect(styles('alphabet')).toEqual(['keep', 'full', 'half']);
		expect(styles('katakana')).toEqual(['keep', 'full']);
	});
});
