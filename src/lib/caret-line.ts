/**
 * 入力欄のカーソルが、見た目の1行目・最終行にあるか。折り返しも1行として数える。
 * 入力欄はカーソルの見た目の位置を返さないので、同じ幅と書式の見えない要素に中身を流し込み、
 * カーソルの位置に置いた印の高さを、先頭と末尾に置いた印の高さと比べる
 */

/** 折り返し方と行の高さに効く書式。見えない要素へ写す */
const TEXT_STYLES = [
	'fontFamily',
	'fontSize',
	'fontStyle',
	'fontVariant',
	'fontWeight',
	'fontStretch',
	'fontKerning',
	'fontFeatureSettings',
	'fontVariationSettings',
	'letterSpacing',
	'wordSpacing',
	'lineHeight',
	'textTransform',
	'textIndent',
	'tabSize',
	'whiteSpace',
	'wordBreak',
	'overflowWrap',
	'lineBreak',
	'hyphens',
	'direction'
] as const;

/** 末尾の印に入れる幅のない文字（U+200B） */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export type CaretLine = { first: boolean; last: boolean };

/**
 * カーソルが見た目の1行目・最終行にあるか。範囲を選んでいるときは null。
 * カーソルが折り返しの位置にあると、上の行の末尾と下の行の先頭のどちらに出ているかは位置からは分からない
 * （上下キーや行頭のクリックで来たカーソルは下の行の先頭に、行末へ移ったカーソルは上の行の末尾に出る）。
 * 迷う位置では履歴に移らない側で数える。1行目かは下の行の先頭の側で、最終行かは上の行の末尾の側で見る。
 * 数え違えても、履歴を出すのにもう1回押すだけで済み、行を移るつもりが履歴に入れ替わることはない
 */
export function caretLine(element: HTMLTextAreaElement): CaretLine | null {
	const { value, selectionStart, selectionEnd } = element;
	if (selectionStart !== selectionEnd) return null;

	const style = getComputedStyle(element);
	const mirror = document.createElement('div');
	for (const name of TEXT_STYLES) mirror.style[name] = style[name];
	// clientWidth は枠線とスクロールバーを除いた幅。中身が流れる幅にするため、左右の余白も除く
	const width =
		element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
	Object.assign(mirror.style, {
		position: 'absolute',
		top: '0',
		left: '0',
		visibility: 'hidden',
		boxSizing: 'content-box',
		padding: '0',
		border: '0',
		width: `${width}px`
	});

	// 印は中身の文字を増やさない。文字を足すと、単語の途中に折り返せる位置ができて、入力欄と折り返し方が変わる
	const start = document.createElement('span');
	/** 上の行の末尾の側。空の印は折り返しの位置で上の行に付く */
	const caret = document.createElement('span');
	/** 下の行の先頭の側。カーソルの直後の1文字を包む。改行や末尾なら空のままで、上の行の末尾の側と変わらない */
	const next = document.createElement('span');
	// 見た目の1文字（書記素）をまるごと包む。WebKit は要素の境目をまたいで字形を組まないので、
	// ハートの絵文字に付ける絵文字の印（U+FE0F）などを切り離すと形が変わり、入力欄と折り返し方が食い違う
	const nextChar = graphemes.segment(value.slice(selectionStart))[Symbol.iterator]().next()
		.value?.segment;
	if (nextChar && nextChar !== '\n') next.textContent = nextChar;
	// 末尾の印だけは幅のない文字を入れる。末尾が改行のとき、空の印では改行の後の行ができないため
	const end = document.createElement('span');
	end.textContent = ZERO_WIDTH_SPACE;
	const rest = value.slice(selectionStart + next.textContent.length);
	mirror.append(start, value.slice(0, selectionStart), caret, next, rest, end);

	document.body.append(mirror);
	try {
		const sameLine = (a: HTMLElement, b: HTMLElement) => Math.abs(a.offsetTop - b.offsetTop) < 1;
		return { first: sameLine(next, start), last: sameLine(caret, end) };
	} finally {
		mirror.remove();
	}
}
