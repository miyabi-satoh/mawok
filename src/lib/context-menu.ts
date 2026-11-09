/**
 * WebView の右クリックのメニューを出してよいか。入力欄（切り取り・貼り付け）と、文字を選んだとき（コピー）だけ出す。
 * それ以外の所のメニューは WebView のブラウザーとしてのメニュー（最新の情報に更新・戻る・印刷など）で、
 * 読み込み直すと下書きの書きかけが消える
 */
export function allowsContextMenu(target: EventTarget | null, selection: string): boolean {
	if (selection !== '') return true;
	if (!(target instanceof Element)) return false;
	if (target.closest('textarea, [contenteditable]:not([contenteditable="false"])')) return true;
	const input = target.closest('input');
	// 文字を打つ欄だけ。チェックボックスや色の選択には、編集のメニューが要らない
	return (
		input != null &&
		!['checkbox', 'radio', 'color', 'range', 'button', 'submit'].includes(input.type)
	);
}
