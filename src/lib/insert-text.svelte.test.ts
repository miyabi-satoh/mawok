import { afterEach, describe, expect, it } from 'vitest';
import { insertAsTyped } from './insert-text';

// insertText は実際の入力欄でしか効かないので、Chromium で入力欄を置いて見る

function textarea(value: string, start: number, end = start): HTMLTextAreaElement {
	const element = document.createElement('textarea');
	element.value = value;
	document.body.append(element);
	element.focus();
	element.setSelectionRange(start, end);
	return element;
}

/** 起きた input イベントを数える */
function countInputs(element: HTMLTextAreaElement): () => number {
	let count = 0;
	element.addEventListener('input', () => count++);
	return () => count;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe('insertAsTyped', () => {
	it('選択範囲を置き換え、カーソルを差し込んだ文の末尾に置く', () => {
		const element = textarea('今日は晴れ', 3, 5);
		const inputs = countInputs(element);

		insertAsTyped(element, '雨です');

		expect(element.value).toBe('今日は雨です');
		expect(element.selectionStart).toBe(6);
		expect(element.selectionEnd).toBe(6);
		expect(inputs()).toBe(1);
	});

	it('insertText が効かなければ、指定した範囲を置き換えて input イベントを起こす', () => {
		const element = textarea('今日は晴れ', 0);
		// readonly の欄には insertText が効かない
		element.readOnly = true;
		const inputs = countInputs(element);

		insertAsTyped(element, '雨です', 3, 5);

		expect(element.value).toBe('今日は雨です');
		expect(element.selectionStart).toBe(6);
		expect(inputs()).toBe(1);
	});
});
