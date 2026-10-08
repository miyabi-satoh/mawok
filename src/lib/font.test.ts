import { describe, expect, it } from 'vitest';
import { DRAFT_FONT_FALLBACK, draftFontFamily } from './font';

/** 指定の後ろには必ず受け皿が付く */
function withFallback(...names: string[]) {
	return [...names, DRAFT_FONT_FALLBACK].join(', ');
}

describe('draftFontFamily', () => {
	it('指定がなければ受け皿だけを返す', () => {
		expect(draftFontFamily('')).toBe(DRAFT_FONT_FALLBACK);
		expect(draftFontFamily('   ')).toBe(DRAFT_FONT_FALLBACK);
	});

	it('受け皿の var() 自身にも並びを持たせる', () => {
		// Tailwind が --font-sans を出力しなくなっても、font-family の宣言ごと無効にならないようにする
		expect(DRAFT_FONT_FALLBACK).toMatch(/^var\(--font-sans, .+sans-serif\)$/);
	});

	it('名前を引用符で囲み、受け皿を後ろに付ける', () => {
		expect(draftFontFamily('HackGen Console NF')).toBe(withFallback('"HackGen Console NF"'));
	});

	it('カンマ区切りで複数書ける', () => {
		expect(draftFontFamily('HackGen, Menlo')).toBe(withFallback('"HackGen"', '"Menlo"'));
	});

	it('総称ファミリーは引用符で囲まない', () => {
		// 囲むと「monospace という名前のフォント」を探しに行ってしまう
		expect(draftFontFamily('monospace')).toBe(withFallback('monospace'));
		expect(draftFontFamily('UI-Monospace')).toBe(withFallback('ui-monospace'));
	});

	it('総称ファミリーと具体的な名前を混ぜられる', () => {
		expect(draftFontFamily('HackGen, monospace')).toBe(withFallback('"HackGen"', 'monospace'));
	});

	it('空の要素を落とす', () => {
		expect(draftFontFamily('HackGen, , ')).toBe(withFallback('"HackGen"'));
	});

	it('引用符付きで書かれた名前を二重に囲まない', () => {
		// VS Code の設定や CSS からそのまま貼れるようにする
		expect(draftFontFamily('"JetBrains Mono", monospace')).toBe(
			withFallback('"JetBrains Mono"', 'monospace')
		);
		expect(draftFontFamily("'JetBrains Mono'")).toBe(withFallback('"JetBrains Mono"'));
	});

	it('引用符とバックスラッシュを escape する', () => {
		// これがないと、名前から CSS の値を抜け出せてしまう
		expect(draftFontFamily('a"b')).toBe(withFallback('"a\\"b"'));
		expect(draftFontFamily('a\\b')).toBe(withFallback('"a\\\\b"'));
	});

	it('改行を取り除く', () => {
		// 残すと CSS の文字列が閉じず、style 属性の後ろの宣言まで落ちる
		expect(draftFontFamily('Menlo\nfoo')).toBe(withFallback('"Menlofoo"'));
		expect(draftFontFamily('Menlo\r\nfoo')).toBe(withFallback('"Menlofoo"'));
	});
});
