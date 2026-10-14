import { describe, expect, it } from 'vitest';
import { isBlankReplacement, isBlankSnippet } from './blank-rows';

describe('空の行', () => {
	it('定型文は、名前と本文が空白だけなら空', () => {
		expect(isBlankSnippet({ name: ' ', body: '\n' })).toBe(true);
		expect(isBlankSnippet({ name: '', body: '本文' })).toBe(false);
		expect(isBlankSnippet({ name: '名前', body: '' })).toBe(false);
	});

	it('置き換え辞書は、空白だけの語も空とみなさない', () => {
		expect(isBlankReplacement({ from: '', to: '' })).toBe(true);
		expect(isBlankReplacement({ from: ' ', to: '' })).toBe(false);
		expect(isBlankReplacement({ from: '', to: '、' })).toBe(false);
	});
});
