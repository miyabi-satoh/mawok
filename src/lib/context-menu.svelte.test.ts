import { describe, expect, it } from 'vitest';
import { allowsContextMenu } from '#lib/context-menu.ts';

function element(html: string) {
	const host = document.createElement('div');
	host.innerHTML = html;
	return host.firstElementChild as Element;
}

describe('allowsContextMenu', () => {
	it('入力欄では出す', () => {
		expect(allowsContextMenu(element('<textarea></textarea>'), '')).toBe(true);
		expect(allowsContextMenu(element('<input type="text">'), '')).toBe(true);
		expect(allowsContextMenu(element('<input type="number">'), '')).toBe(true);
	});

	it('文字を選んでいれば、入力欄の外でも出す', () => {
		expect(allowsContextMenu(element('<p>text</p>'), 'text')).toBe(true);
	});

	it('入力欄の外では出さない', () => {
		expect(allowsContextMenu(element('<button>Copy</button>'), '')).toBe(false);
		expect(allowsContextMenu(element('<div></div>'), '')).toBe(false);
		expect(allowsContextMenu(element('<input type="checkbox">'), '')).toBe(false);
		expect(allowsContextMenu(null, '')).toBe(false);
	});
});
