import { describe, expect, it } from 'vitest';
import { keepsDraftFocus } from './draft-focus';

function element(html: string) {
	const host = document.createElement('div');
	host.innerHTML = html;
	return host.firstElementChild as Element;
}

describe('keepsDraftFocus', () => {
	it('押しても何も起きない所では、入力欄のフォーカスを外さない', () => {
		expect(keepsDraftFocus(element('<div></div>'))).toBe(true);
		expect(keepsDraftFocus(element('<p><span>保存しました。</span></p>').firstElementChild)).toBe(
			true
		);
	});

	it('ボタンや入力欄など、押して使う所ではフォーカスを移す', () => {
		expect(keepsDraftFocus(element('<button><svg></svg></button>').firstElementChild)).toBe(false);
		expect(keepsDraftFocus(element('<textarea></textarea>'))).toBe(false);
		expect(keepsDraftFocus(element('<input type="text">'))).toBe(false);
		expect(keepsDraftFocus(element('<div role="option">x</div>'))).toBe(false);
		expect(keepsDraftFocus(null)).toBe(false);
	});

	it('知らせとエラーは、文字を選べるようフォーカスを移す', () => {
		expect(keepsDraftFocus(element('<p role="status"><span>ab</span></p>').firstElementChild)).toBe(
			false
		);
		expect(keepsDraftFocus(element('<div role="alert"><p>ab</p></div>').firstElementChild)).toBe(
			false
		);
	});
});
