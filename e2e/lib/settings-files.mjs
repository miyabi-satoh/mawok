// 設定の置き場のファイル (docs/config.md「ファイル」) と、デバイスの手元のファイル (device.json) を、E2E から読み書きする。
// テストは画面とのやり取りと同じ camelCase の名前で読み書きするので、ここでファイルの snake_case の名前と付け替える。

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { readTextIfExists } from './files.mjs';

export const SETTINGS_FILE = 'settings.toml';
export const SNIPPETS_FILE = 'snippets.toml';
export const REPLACEMENTS_FILE = 'replacements.toml';
/** デバイスの見分け・選んだ置き場・ログイン時の起動。置き場でなく、OS 標準のアプリのデータのフォルダーに置く (deviceDirOf) */
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

/**
 * device.json を置くフォルダー。アプリ設定フォルダー (`configDir`) と同じ識別子の、OS 標準のアプリのデータのフォルダー
 * (Tauri の app_local_data_dir。docs/config.md「デバイスの手元に置くもの」)。macOS は `configDir` と同じ
 */
export function deviceDirOf(configDir) {
	const identifier = path.basename(configDir);
	switch (process.platform) {
		case 'win32':
			return path.join(process.env.LOCALAPPDATA ?? path.dirname(configDir), identifier);
		case 'linux':
			return path.join(
				process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
				identifier
			);
		default:
			return configDir;
	}
}

/** device.json のパス */
export function deviceFileOf(configDir) {
	return path.join(deviceDirOf(configDir), DEVICE_FILE);
}

/** device.json の中身。無ければ null */
async function readDevice(configDir) {
	const text = await readTextIfExists(deviceFileOf(configDir));
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
	await fs.mkdir(deviceDirOf(configDir), { recursive: true });
	const device = (await readDevice(configDir).catch(() => null)) ?? {};
	await fs.writeFile(
		deviceFileOf(configDir),
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
const HELD_TOP_FILES = [SETTINGS_FILE, SNIPPETS_FILE, REPLACEMENTS_FILE, '.window-state.json'];

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
	// device.json は別のフォルダーにあるが、控えの中では名前だけで持つ
	const device = await readTextIfExists(deviceFileOf(configDir));
	if (device !== null) files[DEVICE_FILE] = device;
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
	if (!(DEVICE_FILE in files)) await fs.rm(deviceFileOf(configDir), { force: true });
	await fs.rm(path.join(configDir, HISTORY_DIR), { recursive: true, force: true });
	for (const [name, text] of Object.entries(files)) {
		const target =
			name === DEVICE_FILE ? deviceFileOf(configDir) : path.join(configDir, ...name.split('/'));
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, text);
	}
}

/** 設定のファイルと device.json と履歴を消す (初めての起動にする)。位置の記録は残す */
export async function removeConfigFiles(configDir) {
	for (const name of [SETTINGS_FILE, SNIPPETS_FILE, REPLACEMENTS_FILE]) {
		await fs.rm(path.join(configDir, name), { force: true });
	}
	await fs.rm(deviceFileOf(configDir), { force: true });
	await fs.rm(path.join(configDir, HISTORY_DIR), { recursive: true, force: true });
}
