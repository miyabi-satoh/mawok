import { describe, expect, it } from 'vitest';
import { CHAR_WIDTH_KINDS } from './setting-options';

describe('設定の選択肢', () => {
	it('カタカナだけは、半角に揃える選択肢を持たない', () => {
		const styles = (kind: string) =>
			CHAR_WIDTH_KINDS.find((row) => row.kind === kind)?.styles.map(({ value }) => value);
		expect(styles('alphabet')).toEqual(['keep', 'full', 'half']);
		expect(styles('katakana')).toEqual(['keep', 'full']);
	});
});
