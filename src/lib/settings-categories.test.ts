import { describe, expect, it } from 'vitest';
import { settingsCategories } from './settings-categories';

describe('settingsCategories', () => {
	it('アクションは、定型文と組み合わせた機器の間に出す', () => {
		const values = settingsCategories().map(({ value }) => value);
		expect(values.indexOf('actions')).toBe(values.indexOf('snippets') + 1);
		expect(values.indexOf('devices')).toBe(values.indexOf('actions') + 1);
	});
});
