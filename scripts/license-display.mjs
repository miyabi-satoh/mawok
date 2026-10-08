// 抽出したライセンスの情報を、画面に出す形に整える (→ docs/third-party-licenses.md「第三者のソフトウェア」)。
// Rust の分 (scripts/generate-rust-licenses.mjs) と npm の分 (scripts/third-party-licenses.ts) が共通で使う。
//
// 抽出の結果は元データで、そのままは見せない。ここで次のように整える。
// - 1パッケージ1件にする。同じ名前の違う版は1件にまとめ、版を並べる。
// - 同じ条文は1つにまとめ、パッケージからは番号で指す (画面では各パッケージの下にそのまま出す)。
// - 見せられない形の本文が残っていたら、書き出さずに止める。

/**
 * @typedef {object} LicenseText
 * @property {string} id SPDX の識別子 (例: `MIT`)。
 * @property {string} name 見出しに出す名前 (例: `MIT License`)。
 * @property {string} text 著作権表示を含む本文。
 */

/**
 * @typedef {object} ExtractedPackage 抽出した1つの版。
 * @property {string} name
 * @property {string} version
 * @property {string} license 宣言しているライセンスの式 (例: `MIT OR Apache-2.0`)。
 * @property {string | null} repository ソースの置き場所 (https のみ)。
 * @property {LicenseText[]} texts このパッケージに当たる本文。`OR` の式では、Rust は cargo-about が選んだ条文だけ、
 *   npm はパッケージが同梱している条文を全部 (1つの本文にファイル名を挟んで並べる)。
 */

/**
 * @typedef {object} DisplayPackage
 * @property {string} name
 * @property {string[]} versions
 * @property {string} license 版ごとに式が違えば ` / ` で並べる。
 * @property {string | null} repository
 * @property {number[]} texts `texts` の添え字。
 */

/**
 * @typedef {object} LicenseDisplay 画面が読む形。
 * @property {LicenseText[]} texts
 * @property {DisplayPackage[]} packages 名前の順。
 */

// SPDX のひな形のまま残った本文の印。Apache-2.0 の末尾の適用例 (`[yyyy] [name of copyright owner]`) は
// 条文の一部なので含めない。
const PLACEHOLDER = /<year>|<owner>|<copyright holders>/;

// 本文に紛れ込んだソースコードの印。ライセンスの注釈を頭に持つソースファイルを、抽出の道具が
// 丸ごと本文として拾うことがある (ring など)。条文の文章に出てこない、コードに特有の形だけを見る。
const CODE_LINE =
	/^\s*(#include\b|#define\b|#ifndef\b|#!\[|\/\/!|use [a-z_]+(::|;)|pub (fn|mod|struct|enum|use|const) |fn [a-z_]+\(|typedef |extern crate )/m;

/**
 * 抽出した版の一覧を、画面に出す形に整える。見せられない本文があれば、まとめて挙げて止める。
 *
 * @param {ExtractedPackage[]} extracted
 * @returns {LicenseDisplay}
 */
export function buildLicenseDisplay(extracted) {
	const problems = [];
	for (const pkg of extracted) {
		const key = `${pkg.name}@${pkg.version}`;
		// 式が空だと、画面の行のライセンスの欄が黙って空になる (`license-file` だけを宣言したクレートなど)。
		if (pkg.license.trim() === '') problems.push(`${key}: ライセンスの式が無い`);
		if (pkg.texts.length === 0 || pkg.texts.some((t) => t.text.trim() === '')) {
			problems.push(`${key}: 本文が無い`);
		}
		for (const t of pkg.texts) {
			if (PLACEHOLDER.test(t.text)) problems.push(`${key}: 著作権者が空欄のひな形 (${t.id})`);
			const code = t.text.match(CODE_LINE);
			if (code) problems.push(`${key}: 本文にコードが混ざっている (${t.id}: ${code[0].trim()})`);
		}
	}
	if (problems.length > 0) {
		throw new Error(`見せられない本文がある。条文を確かめて直す:\n${problems.join('\n')}`);
	}

	/** @type {LicenseText[]} */
	const texts = [];
	const textIndex = new Map();
	/** @param {LicenseText} t */
	const indexOf = (t) => {
		const key = `${t.id}\0${t.text}`;
		if (!textIndex.has(key)) {
			textIndex.set(key, texts.length);
			texts.push(t);
		}
		return textIndex.get(key);
	};

	/** @type {Map<string, ExtractedPackage[]>} */
	const byName = new Map();
	for (const pkg of extracted) byName.set(pkg.name, [...(byName.get(pkg.name) ?? []), pkg]);

	const packages = [...byName.entries()]
		.sort(([a], [b]) => compare(a.toLowerCase(), b.toLowerCase()) || compare(a, b))
		.map(([name, versions]) => {
			versions.sort((a, b) => compareVersions(a.version, b.version));
			return {
				name,
				versions: versions.map((v) => v.version),
				license: unique(versions.map((v) => v.license)).join(' / '),
				repository: versions.find((v) => v.repository !== null)?.repository ?? null,
				texts: unique(versions.flatMap((v) => v.texts.map(indexOf)))
			};
		});
	return { texts, packages };
}

/**
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
function unique(items) {
	return [...new Set(items)];
}

/**
 * 並びを OS やロケールに左右させないため、文字コードの順で比べる。
 *
 * @param {string} a
 * @param {string} b
 */
function compare(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `0.9.4` と `0.10.1` を数の大きさで比べる。数でない部分は文字として比べる。
 *
 * @param {string} a
 * @param {string} b
 */
function compareVersions(a, b) {
	const pa = a.split(/[.+-]/);
	const pb = b.split(/[.+-]/);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const [x, y] = [pa[i] ?? '', pb[i] ?? ''];
		const [nx, ny] = [Number(x), Number(y)];
		const diff =
			x !== '' && y !== '' && !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : compare(x, y);
		if (diff !== 0) return diff;
	}
	return 0;
}
