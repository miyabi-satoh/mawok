import { CONSTANTS } from '$lib/bindings/constants';
import type { Platform } from '$lib/bindings/Platform';

/**
 * `@sh` の行で補う語（docs/actions.md「パスの補完」）。
 * `start` は1行目の中で語が始まる位置、`path` は引用符と `\` を外した後のパス。
 * `quote` は、カーソルの所で開いている引用符。`tilde` は、語の頭の `~` をシェルがホームに広げるか
 */
export type PathWord = {
	start: number;
	path: string;
	quote: '"' | "'" | null;
	tilde: boolean;
};

/** 語を分ける記号のうち、次の語がコマンドの名前になるもの（パイプ・続けて実行・まとめ） */
const COMMAND_SEPARATORS = new Set(['|', '&', ';', '(', ')']);
/** 語を分ける記号のうち、次の語がファイルになるもの（リダイレクト） */
const REDIRECTS = new Set(['<', '>']);

/**
 * 1行目 `line` のカーソル `caret` の前の語が、補えるパスなら返す。
 * `@sh` の行のコマンドの中だけで、コマンドの名前の位置の語は、区切りを含むか `.`・`~` で始まるときだけ補う
 * （`git` のような名前をファイルの名前で補わないため）。変数や置き換え（`$`・`` ` ``、Windows は `%`）を含む語は、
 * シェルが広げる先が分からないので補わない
 */
export function pathWordAt(line: string, caret: number, platform: Platform): PathWord | null {
	const head = line.length - line.trimStart().length;
	const prefix = CONSTANTS.SH_PREFIX;
	if (line.slice(head, head + prefix.length).toLowerCase() !== prefix) return null;
	const commandStart = head + prefix.length;
	if (caret <= commandStart || !/^\s/.test(line.slice(commandStart))) return null;

	const windows = platform === 'windows';
	const expands = (char: string) => (windows ? char === '%' : char === '$' || char === '`');
	let start = caret;
	let path = '';
	let quote: '"' | "'" | null = null;
	let tilde = false;
	let unresolvable = false;
	// 今の語がコマンドの中で何番目か。0 ならコマンドの名前の位置
	let wordIndex = 0;
	let inWord = false;

	const endWord = () => {
		if (inWord) wordIndex += 1;
		inWord = false;
		path = '';
		tilde = false;
		unresolvable = false;
	};
	const addChar = (index: number, char: string) => {
		if (!inWord) {
			inWord = true;
			start = index;
		}
		path += char;
	};

	for (let index = commandStart; index < caret; index += 1) {
		const char = line[index];
		if (quote === "'") {
			if (char === "'") quote = null;
			else path += char;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			else if (
				!windows &&
				char === '\\' &&
				index + 1 < caret &&
				'"\\$`'.includes(line[index + 1])
			) {
				index += 1;
				path += line[index];
			} else {
				if (expands(char)) unresolvable = true;
				path += char;
			}
			continue;
		}
		if (/\s/.test(char)) {
			endWord();
		} else if (windows && char === ';') {
			// cmd の `;` は引数の区切りで、次のコマンドにはならない
			endWord();
		} else if (COMMAND_SEPARATORS.has(char)) {
			endWord();
			wordIndex = 0;
		} else if (REDIRECTS.has(char)) {
			endWord();
			wordIndex = Math.max(wordIndex, 1);
		} else if (char === '"' || (!windows && char === "'")) {
			if (!inWord) {
				inWord = true;
				start = index;
			}
			quote = char;
		} else if (char === (windows ? '^' : '\\')) {
			if (!inWord) {
				inWord = true;
				start = index;
			}
			// カーソルの直前が逃がしの印だけなら、次に打つ文字が決まっていないので補わない
			if (index + 1 >= caret) return null;
			index += 1;
			path += line[index];
		} else {
			if (!inWord && !windows && char === '~') tilde = true;
			if (expands(char)) unresolvable = true;
			addChar(index, char);
		}
	}

	if (!inWord) start = caret;
	if (unresolvable) return null;
	const separators = windows ? /[\\/]/ : /\//;
	// 引用符の中の `~` はシェルが広げないので、ホームとして補うと違うパスになる
	if (!tilde && /^~($|[\\/])/.test(path)) return null;
	// cmd の `/` で始まる語はスイッチ（`dir /b`）で、パスではない
	if (windows && path.startsWith('/')) return null;
	if (wordIndex === 0 && !separators.test(path) && !path.startsWith('.') && !tilde) return null;
	return { start, path, quote, tilde };
}

/** 引用符で囲まずに書くと、シェルが別の意味に読む文字（macOS のシェル。`\` を前に付ける） */
const UNIX_SPECIAL = /[\s'"\\$`!*?[\](){}<>|&;#]/g;
/** cmd が、パスを `"` で囲んで補う文字（cmd 自身の Tab の補完と同じ） */
const CMD_SPECIAL = /[\s&()[\]{}^=;!'+,`~]/;

/**
 * 補ったパスを、語として1行目に書く形にする。補い方は、その OS のシェルの補完に合わせる
 * （macOS は `\` を付け、開いた引用符の中ならその引用符の書き方にする。Windows は `"` で囲む）。
 * `close` なら引用符を閉じる（ファイルに決まったとき。フォルダーは、続けてその中を補えるよう開いたままにする）
 */
export function quotePath(
	path: string,
	word: PathWord,
	platform: Platform,
	close: boolean
): string {
	if (platform === 'windows') {
		if (word.quote !== '"' && !CMD_SPECIAL.test(path)) return path;
		return `"${path}${close ? '"' : ''}`;
	}
	// `~` は引用符の外に置かないとホームに広がらない
	const home = word.tilde ? (path.match(/^~\/?/)?.[0] ?? '') : '';
	const rest = path.slice(home.length);
	if (word.quote === "'") return `${home}'${rest.replaceAll("'", "'\\''")}${close ? "'" : ''}`;
	if (word.quote === '"') return `${home}"${rest.replace(/["\\$`]/g, '\\$&')}${close ? '"' : ''}`;
	// 語の頭の `~`（ほかの人のホーム）と `=`（zsh のコマンドのパス）も、シェルが広げるので逃がす
	const escaped = rest.replace(UNIX_SPECIAL, '\\$&');
	return home + (home === '' && /^[~=]/.test(escaped) ? `\\${escaped}` : escaped);
}

/** 補ったパスがフォルダーか（Rust 側がフォルダーの名前にだけ区切りを付ける） */
export function isFolderPath(path: string, platform: Platform): boolean {
	return path.endsWith('/') || (platform === 'windows' && path.endsWith('\\'));
}

/**
 * 1つに決まったパスを、1行目に入れる語にする。ファイルなら引用符を閉じて空白を足し、続けて次の引数を打てるようにする。
 * フォルダーなら、続けてその中を補えるよう、区切りのところで止める（ターミナルの補完と同じ）。
 * `followed` は、語の後ろがもう空白か。そのときは空白を重ねない
 */
export function completedWord(
	path: string,
	word: PathWord,
	platform: Platform,
	followed = false
): string {
	const folder = isFolderPath(path, platform);
	return quotePath(path, word, platform, !folder) + (folder || followed ? '' : ' ');
}
