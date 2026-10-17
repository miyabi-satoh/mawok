// 設定の置き場 (settings.db。docs/config.md) を、E2E から読み書きする。
// テストは画面とのやり取りと同じ camelCase の名前で読み書きするので、ここで置き場の snake_case の名前と付け替える

import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

export const SETTINGS_FILE = 'settings.db';
/** 読めない置き場を作り直す前に写す先の名前の頭 (`settings.broken-….db`) */
export const BROKEN_PREFIX = 'settings.broken-';

// 表の形は src-tauri/src/store.rs の init と同じ。アプリより先に作るときに、アプリがそのまま読める形にする
const SCHEMA = `
	CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
	CREATE TABLE IF NOT EXISTS sync_outbox (name TEXT PRIMARY KEY, changed_at INTEGER NOT NULL) WITHOUT ROWID;
	CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
	PRAGMA user_version = 1;
`;

// アプリが書いている最中に読むと待たされることがある。少し待って、それでも空かなければ失敗にする
const BUSY_TIMEOUT_MS = 2000;

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
 * 行 (置き換え辞書・定型文) とモデルの表の中は付け替えない (行の項目名は1語で、モデルの表は AI サービスの名前のため)
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

/** 置き場があるか */
export async function settingsExist(file) {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * 置き場の項目を camelCase の名前で読む (既定と違う値だけ)。置き場が無ければ null。
 * アプリが書いている最中などで読めなければ投げる
 */
export async function readSettings(file) {
	if (!(await settingsExist(file))) return null;
	const db = new DatabaseSync(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
	try {
		const rows = db.prepare('SELECT name, value FROM settings').all();
		return Object.fromEntries(
			rows.map(({ name, value }) => renameEntry(name, JSON.parse(value), toCamelCase))
		);
	} finally {
		db.close();
	}
}

/**
 * 置き場の項目を、camelCase の名前で書いた `settings` にそっくり置き換える。null・undefined の項目は書かない (既定値)。
 * 置き場が無ければ作る。同期の記録と oplog は消す (前のテストの同期の状態を持ち越さない)。アプリを止めてから呼ぶこと
 */
export function writeSettings(file, settings) {
	const db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
	try {
		db.exec(SCHEMA);
		db.exec('BEGIN');
		db.exec('DELETE FROM settings; DELETE FROM sync_outbox; DELETE FROM meta;');
		const insert = db.prepare('INSERT INTO settings (name, value) VALUES (?, ?)');
		for (const [name, value] of Object.entries(settings)) {
			if (value === null || value === undefined) continue;
			const [stored, storedValue] = renameEntry(name, value, toSnakeCase);
			insert.run(stored, JSON.stringify(storedValue));
		}
		db.exec('COMMIT');
	} finally {
		db.close();
	}
}
