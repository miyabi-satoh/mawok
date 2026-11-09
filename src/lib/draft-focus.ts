/**
 * 入力欄に打っている最中に押したとき、入力欄からフォーカスを外さない所か。余白・帯など、押しても何も起きない所だけ。
 * 外すと Windows では IME がオフになり、入力欄へ戻して打った文字が半角のまま入る。
 * ボタンは外す（変換中にコピーを押すと、外れることで未確定の文字が確定し、その内容でコピーする）。
 * 知らせとエラーも外す。文字を選んでコピーできるように
 */
export function keepsDraftFocus(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	return !target.closest(
		'button, a, input, textarea, select, label, [contenteditable]:not([contenteditable="false"]), [tabindex], [role="option"], [role="alert"], [role="status"]'
	);
}
