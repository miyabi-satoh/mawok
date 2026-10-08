/**
 * 下書きの入力欄のフォント。設定に書かれた font-family の並びを、CSS に渡せる形に整える。
 *
 * 名前は VS Code の editor.fontFamily や Zed の buffer_font_family と同じく自由に書ける。
 * 入っていないフォントを書いても黙って次の候補に落ちるので、どちらの実例も警告は出していない。
 */

import { CONSTANTS } from '$lib/bindings/constants';

/** 文字の大きさの既定値と、入力欄で受け付ける範囲。決めるのも収めるのも Rust 側（config.rs）で、ここは入力欄の min/max と設定が届く前の表示に使う */
export const DEFAULT_DRAFT_FONT_SIZE: number = CONSTANTS.DEFAULT_DRAFT_FONT_SIZE;
export const MIN_DRAFT_FONT_SIZE: number = CONSTANTS.MIN_DRAFT_FONT_SIZE;
export const MAX_DRAFT_FONT_SIZE: number = CONSTANTS.MAX_DRAFT_FONT_SIZE;

/** CSS が用意している総称ファミリー。これらは引用符で囲むと、ただの名前として扱われてしまう */
const GENERIC_FAMILIES = new Set([
	'serif',
	'sans-serif',
	'monospace',
	'cursive',
	'fantasy',
	'system-ui',
	'ui-serif',
	'ui-sans-serif',
	'ui-monospace',
	'ui-rounded',
	'math',
	'emoji',
	'fangsong'
]);

/**
 * 最後に必ず付ける受け皿。指定が見つからなくても、日本語が豆腐にならないようにする。
 *
 * --font-sans は layout.css の @theme inline にあるが、Tailwind は使われている変数しか出力しない。
 * この文字列を分けたり移したりして拾われなくなると、変数が消えて font-family の宣言ごと無効になるので、
 * var() 自身にも同じ並びを持たせておく（layout.css の --font-sans と同じ内容）
 */
export const DRAFT_FONT_FALLBACK =
	"var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', 'Meiryo UI', system-ui, sans-serif)";

/** 前後を囲んでいる引用符を外す。CSS からそのまま貼った `"JetBrains Mono"` を二重に囲まないため */
function unquote(name: string): string {
	const quoted = /^(["'])(.*)\1$/s.exec(name);
	return quoted ? quoted[2] : name;
}

function quote(name: string): string {
	if (GENERIC_FAMILIES.has(name.toLowerCase())) return name.toLowerCase();
	// 改行が残ると CSS の文字列が閉じず、style 属性の後ろの宣言まで巻き込んで落ちる。名前に改行は要らないので取り除く
	const escaped = name
		.replace(/[\n\r\f\u2028\u2029]/g, '')
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"');
	// 引用符で囲めば、空白や数字で始まる名前もそのまま書ける
	return `"${escaped}"`;
}

/**
 * 設定のフォント名から、font-family に渡す文字列を作る。
 * カンマ区切りで複数書ける。空なら受け皿だけを返し、OS 標準に任せる
 */
export function draftFontFamily(setting: string): string {
	const names = setting
		.split(',')
		.map((name) => unquote(name.trim()).trim())
		.filter((name) => name.length > 0)
		.map(quote);
	return [...names, DRAFT_FONT_FALLBACK].join(', ');
}
