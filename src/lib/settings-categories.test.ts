import { describe, expect, it } from 'vitest';
import { settingsCategories } from './settings-categories';

describe('settingsCategories', () => {
	it('同期は定型文の次に出す', () => {
		const values = settingsCategories().map(({ value }) => value);
		expect(values.indexOf('sync')).toBe(values.indexOf('snippets') + 1);
	});
});
