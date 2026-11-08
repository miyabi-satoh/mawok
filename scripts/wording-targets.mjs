// 利用者が読む日本語の文言の置き場と、その中から文言だけを取り出す読み方。
// check-parentheses.mjs と check-long-vowel.mjs が同じ置き場を見るので、ここに集める。

import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');

// トレイとエラーは src-tauri/src/i18n.rs。
const files = ['messages/ja.json', 'docs/manual/ja.md', 'src-tauri/src/i18n.rs'];

// コードの文言は文字列の中だけを見る。コメントの括弧や語は、利用者に見えないため。
const literal = /`[^`]*`|'[^']*'|"[^"]*"/g;
const comment = /^\s*(\/\/|\/?\*)/;

/** 置き場ごとの、行番号付きの文言。Markdown のコードと、リンクの URL は除く */
export function* wordingLines() {
	for (const file of files) {
		const code = file.endsWith('.rs');
		const lines = readFileSync(path.join(root, file), 'utf8').split('\n');
		for (const [index, line] of lines.entries()) {
			let text = line;
			if (code) {
				if (comment.test(line)) continue;
				text = (line.match(literal) ?? []).join(' ');
			} else if (file.endsWith('.md')) {
				text = line.replace(/`[^`]*`/g, '');
			}
			// リンクの URL は文言でないので除く
			yield { file, line: index + 1, text: text.replace(/\]\([^)]*\)/g, ']') };
		}
	}
}
