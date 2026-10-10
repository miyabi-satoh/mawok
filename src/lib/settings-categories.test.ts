import { describe, expect, it } from 'vitest';
import { settingsCategories } from './settings-categories';

describe('settingsCategories', () => {
	it('アカウントは機器の次に出す', () => {
		const values = settingsCategories().map(({ value }) => value);
		expect(values.indexOf('actions')).toBe(values.indexOf('snippets') + 1);
		expect(values.indexOf('devices')).toBe(values.indexOf('actions') + 1);
		expect(values.indexOf('account')).toBe(values.indexOf('devices') + 1);
	});
});
