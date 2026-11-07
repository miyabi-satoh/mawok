// 設定の置き場のファイル (docs/config.md「ファイル」) と、デバイスの手元のファイル (device.json) を、E2E から読み書きする。
// テストは画面とのやり取りと同じ camelCase の名前で読み書きするので、ここでファイルの snake_case の名前と付け替える。
// TOML の読み書きは、依存を増やさないよう、アプリ (toml_edit) が書く形とここで書く形に足りる分だけを自前で持つ

import fs from 'node:fs/promises';
import path from 'node:path';
import { readTextIfExists } from './files.mjs';

export const SETTINGS_FILE = 'settings.toml';
export const SNIPPETS_FILE = 'snippets.toml';
export const REPLACEMENTS_FILE = 'replacements.toml';
/** デバイスの見分け・選んだ置き場・ログイン時の起動。置き場でなく、OS 標準のアプリ設定フォルダーに置く */
export const DEVICE_FILE = 'device.json';
/** 置き場の中の、デバイスごとの履歴 (`<デバイスの見分け>.json`) のフォルダー */
export const HISTORY_DIR = 'history';

/** 行の並びを1つのファイルに置く項目と、そのファイル (src-tauri/src/settings_files.rs の ROW_FILES) */
const ROW_FILES = { snippets: SNIPPETS_FILE, replacements: REPLACEMENTS_FILE };
/** OS ごとに欄を分ける項目 (settings_files.rs の PER_OS) */
const PER_OS = ['hotkey', 'text_window_keys'];
/** デバイスの手元に置く項目 (config.rs の IN_FILES に無い項目) */
const DEVICE_ITEMS = ['autostart'];

/** 回している OS の、ファイルの中の名前 (config.rs の choice_name) */
export const HOST_OS = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];

/** `text_window_keys` → `textWindowKeys` */
function toCamelCase(name) {
	return name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/** `textWindowKeys` → `text_window_keys` */
function toSnakeCase(name) {
	return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * 項目名を付け替える。キー操作の表の操作名 (`history_older` ↔ `historyOlder`) も付け替え、
 * 行 (置き換え辞書・定型文) の中は付け替えない (行の項目名は1語のため)
 */
function renameEntry(name, value, rename) {
	const renamed = rename(name);
	if (toSnakeCase(name) === 'text_window_keys' && value && typeof value === 'object') {
		return [
			renamed,
			Object.fromEntries(Object.entries(value).map(([key, item]) => [rename(key), item]))
		];
	}
	return [renamed, value];
}

/** device.json の中身。無ければ null */
async function readDevice(configDir) {
	const text = await readTextIfExists(path.join(configDir, DEVICE_FILE));
	return text === null ? null : JSON.parse(text);
}

/** 今の置き場のフォルダー。device.json で選んでいなければ、OS 標準のアプリ設定フォルダー (`configDir`) */
export async function settingsDirOf(configDir) {
	return (await readDevice(configDir))?.settings_dir ?? configDir;
}

/** このデバイスの履歴のファイル。デバイスの見分けがまだ無ければ (一度も起動していない) null */
export async function historyFileOf(configDir) {
	const device = await readDevice(configDir);
	if (!device?.id) return null;
	return path.join(device.settings_dir ?? configDir, HISTORY_DIR, `${device.id}.json`);
}

/**
 * 置き場の項目を camelCase の名前で読む (ファイルに書いてある値だけ。OS ごとの項目は、回している OS の値)。
 * ログイン時の起動は device.json から読む。どのファイルも無ければ null。読めないファイルがあれば投げる
 */
export async function readSettings(configDir) {
	const device = await readDevice(configDir);
	const dir = device?.settings_dir ?? configDir;
	const entries = {};
	let found = device !== null;
	const settingsText = await readTextIfExists(path.join(dir, SETTINGS_FILE));
	if (settingsText !== null) {
		found = true;
		for (const [name, value] of Object.entries(parseToml(settingsText))) {
			if (PER_OS.includes(name)) {
				if (value?.[HOST_OS] !== undefined) entries[name] = value[HOST_OS];
			} else if (!(name in ROW_FILES)) {
				entries[name] = value;
			}
		}
	}
	for (const [name, file] of Object.entries(ROW_FILES)) {
		const text = await readTextIfExists(path.join(dir, file));
		if (text === null) continue;
		found = true;
		const rows = parseToml(text)[name];
		if (rows !== undefined) entries[name] = rows;
	}
	for (const name of DEVICE_ITEMS) {
		if (device?.[name] !== undefined && device[name] !== null) entries[name] = device[name];
	}
	if (!found) return null;
	return Object.fromEntries(
		Object.entries(entries).map(([name, value]) => renameEntry(name, value, toCamelCase))
	);
}

/**
 * 置き場の項目を、camelCase の名前で書いた `settings` にそっくり置き換える。null・undefined の項目は書かない (既定値)。
 * 置き場は OS 標準のアプリ設定フォルダー (`configDir`) に戻し、デバイスの見分けは引き継ぐ。アプリを止めてから呼ぶこと
 */
export async function writeSettings(configDir, settings) {
	const stored = Object.fromEntries(
		Object.entries(settings)
			.filter(([, value]) => value !== null && value !== undefined)
			.map(([name, value]) => renameEntry(name, value, toSnakeCase))
	);
	await fs.mkdir(configDir, { recursive: true });
	const device = (await readDevice(configDir).catch(() => null)) ?? {};
	await fs.writeFile(
		path.join(configDir, DEVICE_FILE),
		JSON.stringify({ ...device, settings_dir: null, autostart: stored.autostart ?? null }, null, 2)
	);
	const top = {};
	for (const [name, value] of Object.entries(stored)) {
		if (DEVICE_ITEMS.includes(name) || name in ROW_FILES) continue;
		top[name] = PER_OS.includes(name) ? { [HOST_OS]: value } : value;
	}
	const files = {
		[SETTINGS_FILE]: top,
		...Object.fromEntries(
			Object.entries(ROW_FILES).map(([name, file]) => [
				file,
				stored[name]?.length ? { [name]: stored[name] } : {}
			])
		)
	};
	for (const [file, document] of Object.entries(files)) {
		const target = path.join(configDir, file);
		if (Object.keys(document).length === 0) await fs.rm(target, { force: true });
		else await fs.writeFile(target, stringifyToml(document));
	}
}

/** 控えて戻すファイル。履歴は、置き場の history フォルダーの中をまるごと */
const HELD_TOP_FILES = [
	SETTINGS_FILE,
	SNIPPETS_FILE,
	REPLACEMENTS_FILE,
	DEVICE_FILE,
	'.window-state.json'
];

/**
 * OS 標準のアプリ設定フォルダーの、設定・デバイス・履歴・位置の記録の今の中身 (`{ 相対パス: 中身 }`。無いファイルは載せない)。
 * テストは置き場を選ばずに回すので、置き場はこのフォルダーのものだけを控える
 */
export async function snapshotConfigDir(configDir) {
	const files = {};
	for (const name of HELD_TOP_FILES) {
		const text = await readTextIfExists(path.join(configDir, name));
		if (text !== null) files[name] = text;
	}
	const history = path.join(configDir, HISTORY_DIR);
	for (const name of await fs.readdir(history).catch(() => [])) {
		files[`${HISTORY_DIR}/${name}`] = await fs.readFile(path.join(history, name), 'utf8');
	}
	return files;
}

/** `snapshotConfigDir` の中身に戻す。控えに無いファイルは消す */
export async function restoreConfigDir(configDir, files) {
	for (const name of HELD_TOP_FILES) {
		if (!(name in files)) await fs.rm(path.join(configDir, name), { force: true });
	}
	await fs.rm(path.join(configDir, HISTORY_DIR), { recursive: true, force: true });
	for (const [name, text] of Object.entries(files)) {
		const target = path.join(configDir, ...name.split('/'));
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, text);
	}
}

/** 設定のファイルと device.json と履歴を消す (初めての起動にする)。位置の記録は残す */
export async function removeConfigFiles(configDir) {
	for (const name of [SETTINGS_FILE, SNIPPETS_FILE, REPLACEMENTS_FILE, DEVICE_FILE]) {
		await fs.rm(path.join(configDir, name), { force: true });
	}
	await fs.rm(path.join(configDir, HISTORY_DIR), { recursive: true, force: true });
}

// ── TOML ──

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function tomlKey(key) {
	return BARE_KEY.test(key) ? key : tomlString(key);
}

const NAMED_ESCAPES = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r' };

function tomlString(text) {
	let escaped = '';
	for (const char of text) {
		const code = char.codePointAt(0);
		escaped +=
			NAMED_ESCAPES[char] ??
			(code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : char);
	}
	return `"${escaped}"`;
}

const isTable = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTableArray = (value) => Array.isArray(value) && value.length > 0 && value.every(isTable);

function tomlValue(value) {
	if (typeof value === 'string') return tomlString(value);
	if (typeof value === 'boolean') return String(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`TOML に書けない数です: ${value}`);
		return String(value);
	}
	if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
	if (isTable(value))
		return `{ ${Object.entries(value)
			.map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`)
			.join(', ')} }`;
	throw new Error(`TOML に書けない値です: ${JSON.stringify(value)}`);
}

/** 値を書いてから、表 (`[a.b]`) と表の並び (`[[a]]`) を書く。toml_edit が書くのと同じ形 */
function stringifyTable(table, prefix, lines) {
	const nested = [];
	for (const [key, value] of Object.entries(table)) {
		if (isTable(value) || isTableArray(value)) nested.push([key, value]);
		else lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
	}
	for (const [key, value] of nested) {
		const name = [...prefix, tomlKey(key)];
		if (isTableArray(value)) {
			for (const row of value) {
				lines.push('', `[[${name.join('.')}]]`);
				stringifyTable(row, name, lines);
			}
		} else {
			// 下の表しか持たない表の見出しは書かない (`[a.b]` だけで足りる)
			const hasValues = Object.values(value).some((item) => !isTable(item) && !isTableArray(item));
			if (hasValues || Object.keys(value).length === 0) lines.push('', `[${name.join('.')}]`);
			stringifyTable(value, name, lines);
		}
	}
}

export function stringifyToml(document) {
	const lines = [];
	stringifyTable(document, [], lines);
	return `${lines.join('\n').trimStart()}\n`;
}

/** TOML を読む。日時の値は使わないので読まない (読めない値として投げる) */
export function parseToml(text) {
	let at = 0;
	const fail = (message) => {
		const line = text.slice(0, at).split('\n').length;
		throw new Error(`TOML を読めません (${line} 行目): ${message}`);
	};
	const peek = (s) => text.startsWith(s, at);
	const skipSpaces = () => {
		while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at++;
	};
	const skipComment = () => {
		if (text[at] === '#') while (at < text.length && text[at] !== '\n') at++;
	};
	/** 空白・改行・コメントを飛ばす (配列の中など) */
	const skipBlank = () => {
		for (;;) {
			skipSpaces();
			skipComment();
			if (text[at] === '\n' || text[at] === '\r') at++;
			else return;
		}
	};
	const endOfLine = () => {
		skipSpaces();
		skipComment();
		if (at < text.length && !peek('\n') && !peek('\r\n')) fail('行の終わりに余計な文字があります');
	};

	const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
	const escape = () => {
		const char = text[at++];
		if (char in ESCAPES) return ESCAPES[char];
		if (char === 'u' || char === 'U') {
			const length = char === 'u' ? 4 : 8;
			const hex = text.slice(at, at + length);
			if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== length) fail('読めない \\u です');
			at += length;
			return String.fromCodePoint(parseInt(hex, 16));
		}
		return fail(`読めないエスケープです: \\${char}`);
	};

	const string = () => {
		if (peek('"""') || peek("'''")) {
			const quote = text.slice(at, at + 3);
			at += 3;
			if (peek('\r\n')) at += 2;
			else if (peek('\n')) at++;
			let value = '';
			for (;;) {
				if (at >= text.length) fail('文字列が閉じていません');
				if (peek(quote) && !text.startsWith(quote[0], at + 3)) {
					at += 3;
					return value;
				}
				if (peek(quote)) {
					// 閉じる引用符の前に引用符が続く (`""""`)。1文字を中身にする
					value += text[at++];
					continue;
				}
				if (quote === '"""' && text[at] === '\\') {
					at++;
					// 行末の \ は、次の空白でない文字までを飛ばす
					if (/^[ \t]*\r?\n/.test(text.slice(at))) {
						while (/\s/.test(text[at] ?? '')) at++;
						continue;
					}
					value += escape();
					continue;
				}
				value += text[at++];
			}
		}
		const quote = text[at++];
		let value = '';
		for (;;) {
			const char = text[at];
			if (char === undefined || char === '\n') fail('文字列が閉じていません');
			at++;
			if (char === quote) return value;
			value += quote === '"' && char === '\\' ? escape() : char;
		}
	};

	const key = () => {
		skipSpaces();
		if (text[at] === '"' || text[at] === "'") return string();
		const start = at;
		while (at < text.length && /[A-Za-z0-9_-]/.test(text[at])) at++;
		if (start === at) fail('名前がありません');
		return text.slice(start, at);
	};
	const dottedKey = () => {
		const keys = [key()];
		skipSpaces();
		while (text[at] === '.') {
			at++;
			keys.push(key());
			skipSpaces();
		}
		return keys;
	};

	const value = () => {
		skipSpaces();
		const char = text[at];
		if (char === '"' || char === "'") return string();
		if (char === '[') {
			at++;
			const items = [];
			for (;;) {
				skipBlank();
				if (text[at] === ']') {
					at++;
					return items;
				}
				items.push(value());
				skipBlank();
				if (text[at] === ',') at++;
				else if (text[at] !== ']') fail('配列の区切りがありません');
			}
		}
		if (char === '{') {
			at++;
			const table = {};
			skipSpaces();
			if (text[at] === '}') {
				at++;
				return table;
			}
			for (;;) {
				const keys = dottedKey();
				skipSpaces();
				if (text[at++] !== '=') fail('= がありません');
				assign(table, keys, value());
				skipSpaces();
				if (text[at] === ',') at++;
				else if (text[at] === '}') {
					at++;
					return table;
				} else fail('表の区切りがありません');
			}
		}
		const match = /^[^\s,\]}#]+/.exec(text.slice(at));
		if (!match) return fail('値がありません');
		at += match[0].length;
		const word = match[0];
		if (word === 'true') return true;
		if (word === 'false') return false;
		if (/^[+-]?(\d[\d_]*)$/.test(word)) return Number(word.replace(/_/g, ''));
		if (/^0x[0-9A-Fa-f_]+$/.test(word)) return parseInt(word.slice(2).replace(/_/g, ''), 16);
		if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(word))
			return Number(word.replace(/_/g, ''));
		if (/^[+-]?inf$/.test(word)) return word.startsWith('-') ? -Infinity : Infinity;
		if (/^[+-]?nan$/.test(word)) return NaN;
		return fail(`読めない値です: ${word}`);
	};

	const assign = (table, keys, item) => {
		let current = table;
		for (const name of keys.slice(0, -1)) {
			current[name] ??= {};
			current = current[name];
			if (!isTable(current)) fail(`${keys.join('.')} は表ではありません`);
		}
		const last = keys.at(-1);
		if (Object.hasOwn(current, last)) fail(`${keys.join('.')} が重なっています`);
		current[last] = item;
	};

	const root = {};
	let current = root;
	for (;;) {
		skipBlank();
		if (at >= text.length) return root;
		if (peek('[[')) {
			at += 2;
			const keys = dottedKey();
			if (!peek(']]')) fail(']] がありません');
			at += 2;
			endOfLine();
			let parent = root;
			for (const name of keys.slice(0, -1)) {
				parent[name] ??= {};
				parent = Array.isArray(parent[name]) ? parent[name].at(-1) : parent[name];
			}
			const last = keys.at(-1);
			parent[last] ??= [];
			if (!Array.isArray(parent[last])) fail(`${keys.join('.')} は表の並びではありません`);
			current = {};
			parent[last].push(current);
		} else if (text[at] === '[') {
			at++;
			const keys = dottedKey();
			if (text[at++] !== ']') fail('] がありません');
			endOfLine();
			let table = root;
			for (const name of keys) {
				table[name] ??= {};
				table = Array.isArray(table[name]) ? table[name].at(-1) : table[name];
				if (!isTable(table)) fail(`${keys.join('.')} は表ではありません`);
			}
			current = table;
		} else {
			const keys = dottedKey();
			skipSpaces();
			if (text[at++] !== '=') fail('= がありません');
			assign(current, keys, value());
			endOfLine();
		}
	}
}
