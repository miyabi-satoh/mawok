import { describe, expect, it } from 'vitest';
import { modifiedName } from './modified-settings';

describe('modifiedName', () => {
	it('既定から変えた設定なら名前を、変えていなければ undefined を返す', () => {
		const view = { modifiedSettings: ['theme', 'text_window_keys.copy'] };
		expect(modifiedName(view, 'theme')).toBe('theme');
		expect(modifiedName(view, 'text_window_keys.copy')).toBe('text_window_keys.copy');
		expect(modifiedName(view, 'language')).toBeUndefined();
	});
});
