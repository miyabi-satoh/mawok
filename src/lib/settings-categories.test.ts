import { describe, expect, it } from 'vitest';
import { settingsCategories } from './settings-categories';

describe('settingsCategories', () => {
	it('AI は定型文の次に、アカウントはデバイスの次に出す', () => {
		const values = settingsCategories().map(({ value }) => value);
		expect(values.indexOf('ai')).toBe(values.indexOf('snippets') + 1);
		expect(values.indexOf('devices')).toBe(values.indexOf('ai') + 1);
		expect(values.indexOf('account')).toBe(values.indexOf('devices') + 1);
	});
});
