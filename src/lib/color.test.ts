import { describe, expect, it } from 'vitest';
import { normalizeTextColor } from './color';

describe('normalizeTextColor', () => {
	it('#rrggbb を小文字に揃える', () => {
		expect(normalizeTextColor('#2F4F4F')).toBe('#2f4f4f');
	});

	it('#rgb を #rrggbb に広げる', () => {
		expect(normalizeTextColor('#AbC')).toBe('#aabbcc');
	});

	it('前後の ASCII の空白は取り除く', () => {
		expect(normalizeTextColor('  #123456 ')).toBe('#123456');
		expect(normalizeTextColor('\t#abc\r\n')).toBe('#aabbcc');
	});

	it('垂直タブは取り除かず、読めない値にする（Rust の is_ascii_whitespace に含まれないため）', () => {
		expect(normalizeTextColor('#abc')).toBeNull();
	});

	it('ASCII でない空白は取り除かず、読めない値にする（Rust 側と同じ結果にするため）', () => {
		// JS の trim は BOM を、Rust の trim は U+0085 を取り除くので、どちらの trim にも頼らない
		for (const value of ['﻿#abc', '#abc', '　#abc', '#abc ']) {
			expect(normalizeTextColor(value), JSON.stringify(value)).toBeNull();
		}
	});

	it('空なら空（標準の色）のまま', () => {
		expect(normalizeTextColor('')).toBe('');
		expect(normalizeTextColor('   ')).toBe('');
	});

	it('色として読めない値は null', () => {
		for (const value of ['red', '123456', '#12345', '#1234567', '#ggg', 'oklch(0.5 0 0)']) {
			expect(normalizeTextColor(value), value).toBeNull();
		}
	});
});
