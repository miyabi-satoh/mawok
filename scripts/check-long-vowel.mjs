// 利用者に見える日本語の文言で、語末の長音を落とした外来語 (`フォルダ`・`ブラウザ` など) を
// 見る (→ AGENTS.md「文言」)。macOS などが長音なしで書く語は、書く人の手元の表記に引かれて戻りやすい。
// 決まりそのもの (-er・-or・-ar は付ける) は機械では見分けられないので、取り違えやすい語だけを並べる。

import { wordingLines } from './wording-targets.mjs';

const words = [
	'フォルダ',
	'ブラウザ',
	'ビューア',
	'サーバ',
	'ユーザ',
	'フィルタ',
	'ヘッダ',
	'フッタ',
	'コンピュータ',
	'エディタ',
	'プリンタ',
	'モニタ',
	'パラメータ',
	'メンバ',
	'カレンダ',
	'マネージャ',
	'コントローラ'
];
// 上の語で始まる別の語。後ろのカタカナで一律に除くと「サーバレス」のような複合語の抜けを見逃すので、1語ずつ並べる。
const exceptions = ['ユーザビリティ', 'フィルタリング', 'モニタリング'];
const pattern = new RegExp(`(?!${exceptions.join('|')})(?:${words.join('|')})(?!ー)`, 'g');

const violations = [];
for (const { file, line, text } of wordingLines()) {
	for (const match of text.matchAll(pattern)) violations.push(`${file}:${line}: ${match[0]}`);
}

if (violations.length > 0) {
	console.error(
		'外来語の語末の長音を付けてください (→ AGENTS.md「文言」。長音の無い別の語なら scripts/check-long-vowel.mjs の exceptions に足す):'
	);
	for (const violation of violations) console.error(`  ${violation}`);
	process.exit(1);
}
