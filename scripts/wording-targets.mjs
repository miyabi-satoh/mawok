// 利用者が読む日本語の文言の置き場と、その中から文言だけを取り出す読み方。
// check-parentheses.mjs と check-long-vowel.mjs が同じ置き場を見るので、ここに集める。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');

// 窓口の画面とメールは account-server/src/i18n.ts、トレイとエラーは src-tauri/src/i18n.rs。
// 紹介のサイト (site/) は、文章の書き方を amiiby-site の決まりに揃えるので、長音だけを見る。
export const targets = [
	{ path: 'messages/ja.json', parentheses: true },
	{ path: 'docs/manual/ja.md', parentheses: true },
	{ path: 'src-tauri/src/i18n.rs', parentheses: true },
	{ path: 'account-server/src/i18n.ts', parentheses: true },
	{ path: 'site/src/content', parentheses: false },
	{ path: 'site/src/pages', parentheses: false }
];
const extensions = /\.(json|md|astro|ts|rs)$/;

function files(relative) {
	const absolute = path.join(root, relative);
	if (!statSync(absolute).isDirectory()) return [relative];
	return readdirSync(absolute, { recursive: true })
		.map((entry) => `${relative}/${entry.split(path.sep).join('/')}`)
		.filter((entry) => extensions.test(entry));
}

// コードの文言は文字列の中だけを見る。コメントの括弧や語は、利用者に見えないため。
const literal = /`[^`]*`|'[^']*'|"[^"]*"/g;
const comment = /^\s*(\/\/|\/?\*)/;

/** 置き場ごとの、行番号付きの文言。Markdown のコードと、リンクの URL は除く */
export function* wordingLines(filter = () => true) {
	for (const target of targets.filter(filter)) {
		for (const file of files(target.path)) {
			const code = /\.(ts|rs)$/.test(file);
			const lines = readFileSync(path.join(root, file), 'utf8').split('\n');
			for (const [index, line] of lines.entries()) {
				let text = line;
				if (code) {
					if (comment.test(line)) continue;
					text = (line.match(literal) ?? []).join(' ');
				} else if (file.endsWith('.md')) {
					text = line.replace(/`[^`]*`/g, '');
				}
				// 窓口の文言も、リンクを Markdown で書く
				yield { file, line: index + 1, text: text.replace(/\]\([^)]*\)/g, ']') };
			}
		}
	}
}
