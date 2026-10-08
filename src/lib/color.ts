/**
 * 下書きの文字色の標準。layout.css の --foreground（ライト oklch(0.25 0 0)、ダーク oklch(0.88 0 0)）を #rrggbb にしたもの。
 * 色見本（input type="color"）は #rrggbb しか扱えないので、既定のときはこの色を見せる
 */
export const DEFAULT_TEXT_COLORS = { light: '#222222', dark: '#d7d7d7' } as const;

export type TextColorTheme = keyof typeof DEFAULT_TEXT_COLORS;

/**
 * 文字色を小文字の #rrggbb に揃える。#rgb も受け付ける。空は空（標準の色）のまま。
 * 色として読めなければ null。Rust 側の config::normalize_text_color と同じ決まり
 */
export function normalizeTextColor(value: string): string | null {
	// 取り除くのは ASCII の空白だけ。JS の trim は BOM を、Rust の trim は U+0085 を取り除き、結果が食い違うため
	const text = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
	if (text === '') return '';
	const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
	if (!match) return null;
	const hex =
		match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join('') : match[1];
	return `#${hex.toLowerCase()}`;
}
