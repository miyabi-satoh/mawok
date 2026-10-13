// Rust の依存のライセンス表示 (static/third-party-licenses/rust.json) を作る入力と、その結果から取る印。
// 入力も結果も変わっていなければ、作り直しても同じものになるので、`just licenses-check` は作り直しを飛ばす
// (cargo-about での作り直しは1分ほどかかり、検査のたびに流すと `just ci` の4分の1を占めるため)。
//
// cargo-about 自体の版は入力に数えていない (版は DEVELOPMENT.md と CI で揃えている)。版を上げたときは
// `just licenses` で作り直す。

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const OUTPUT = 'static/third-party-licenses/rust.json';
export const STAMP = 'src-tauri/rust-licenses.stamp';
const TEXTS_DIR = 'src-tauri/license-texts';

/** 結果を左右するファイル。依存とその版、数え方と差し替えの設定、整える手順 */
const INPUTS = [
	'src-tauri/Cargo.toml',
	'src-tauri/Cargo.lock',
	'src-tauri/about.toml',
	'scripts/generate-rust-licenses.mjs',
	'scripts/license-display.mjs',
	'scripts/rust-licenses-stamp.mjs'
];

/** 今の入力と結果から取った印。結果がまだ無ければ `null` */
export function computeStamp() {
	const texts = readdirSync(TEXTS_DIR)
		.sort()
		.map((name) => join(TEXTS_DIR, name));
	const hash = createHash('sha256');
	try {
		for (const file of [...INPUTS, ...texts, OUTPUT]) {
			// checkout の設定で改行が CRLF になっていても、同じ印になるようにする
			hash.update(readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
			hash.update('\0');
		}
	} catch (err) {
		if (err.code === 'ENOENT') return null;
		throw err;
	}
	return hash.digest('hex');
}

/** リポジトリに入れてある印。無ければ `null` */
export function readStamp() {
	try {
		return readFileSync(STAMP, 'utf8').trim();
	} catch (err) {
		if (err.code === 'ENOENT') return null;
		throw err;
	}
}
