/**
 * 入力欄の選択範囲を text で置き換え、カーソルを差し込んだ文の末尾に置く。
 * 取り消し（Cmd+Z）で戻せるよう、打ったのと同じ扱いの insertText で入れる。input イベントも起きる。
 * insertText が効かなければ、start から end を置き換えて input イベントを自分で起こす。
 * insertText はフォーカスのある欄に入るので、呼ぶ前に element にフォーカスを移しておく
 */
export function insertAsTyped(
	element: HTMLTextAreaElement,
	text: string,
	start = element.selectionStart,
	end = element.selectionEnd
) {
	if (document.execCommand('insertText', false, text)) return;
	element.setRangeText(text, start, end, 'end');
	element.dispatchEvent(new Event('input', { bubbles: true }));
}
