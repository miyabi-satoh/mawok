import { afterEach, describe, expect, it } from 'vitest';
import { caretLine } from './caret-line';

// 見た目の行は実際に描かないと分からないので、Chromium で描いて見る

/** 1行に全角で10文字ほど入る入力欄を作り、カーソルを置く */
function textarea(value: string, start: number, end = start): HTMLTextAreaElement {
	const element = document.createElement('textarea');
	Object.assign(element.style, {
		width: '10em',
		padding: '8px',
		fontSize: '16px',
		lineHeight: '1.5'
	});
	element.rows = 10;
	element.value = value;
	document.body.append(element);
	element.setSelectionRange(start, end);
	return element;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe('caretLine', () => {
	it('改行で分かれた行を数える', () => {
		const text = '1行目\n2行目\n3行目';
		expect(caretLine(textarea(text, 0))).toEqual({ first: true, last: false });
		expect(caretLine(textarea(text, 5))).toEqual({ first: false, last: false });
		expect(caretLine(textarea(text, text.length))).toEqual({ first: false, last: true });
	});

	it('折り返して見た目が複数行になった行も数える', () => {
		const text = 'あ'.repeat(30);
		expect(caretLine(textarea(text, 2))).toEqual({ first: true, last: false });
		expect(caretLine(textarea(text, 15))).toEqual({ first: false, last: false });
		expect(caretLine(textarea(text, 28))).toEqual({ first: false, last: true });
	});

	it('折り返しの位置では、履歴に移らない側で数える', () => {
		// 10文字ずつ折り返すので、10 は1行目の末尾とも2行目の先頭とも取れる。
		// 上下キーで来たカーソルは2行目の先頭に出るので、1行目とは数えない
		const text = 'あ'.repeat(30);
		expect(caretLine(textarea(text, 10))).toEqual({ first: false, last: false });
		// 20 は2行目の末尾の側で見て、最終行とは数えない
		expect(caretLine(textarea(text, 20))).toEqual({ first: false, last: false });
	});

	it('カーソルの直後が、いくつかの符号でできた1文字でも数える', () => {
		// ハート（U+2764）に絵文字の印（U+FE0F）を付けたものと、1 に絵文字の印と囲みの印（U+20E3）を付けたもの。1行に収まる
		expect(caretLine(textarea('a\u2764\ufe0fb', 1))).toEqual({ first: true, last: true });
		expect(caretLine(textarea('a1\ufe0f\u20e3b', 1))).toEqual({ first: true, last: true });
	});

	it('1行に収まっていれば、1行目でもあり最終行でもある', () => {
		expect(caretLine(textarea('git status', 4))).toEqual({ first: true, last: true });
		expect(caretLine(textarea('', 0))).toEqual({ first: true, last: true });
	});

	it('末尾が改行なら、その後の空の行が最終行', () => {
		expect(caretLine(textarea('abc\n', 3))).toEqual({ first: true, last: false });
		expect(caretLine(textarea('abc\n', 4))).toEqual({ first: false, last: true });
	});

	it('範囲を選んでいるときは null', () => {
		expect(caretLine(textarea('git status', 0, 3))).toBeNull();
	});
});
