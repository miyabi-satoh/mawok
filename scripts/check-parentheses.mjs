// 利用者に見える日本語の文言で、括弧の書き方が決まり (半角の括弧、外側の和文との間に空白) から
// 外れたものを見る (→ AGENTS.md「文言」)。全角の括弧は、書く人や訳した AI の手元の表記に引かれて混ざりやすい。

import { wordingLines } from './wording-targets.mjs';

const fullWidth = /[（）]/g;
// 和文の文字に半角の括弧が直に接しているもの。「」などの約物との間には空白を入れない。
const tight =
	/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー]\(|\)[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー]/gu;

const violations = [];
for (const { file, line, text } of wordingLines((target) => target.parentheses)) {
	for (const match of [...text.matchAll(fullWidth), ...text.matchAll(tight)]) {
		violations.push(`${file}:${line}: ${match[0]}`);
	}
}

if (violations.length > 0) {
	console.error(
		'括弧は半角で書き、外側の和文との間に半角の空白を入れてください (→ AGENTS.md「文言」):'
	);
	for (const violation of violations) console.error(`  ${violation}`);
	process.exit(1);
}
