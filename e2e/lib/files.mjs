import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// OS によらないファイルの読み書き (Windows の E2E・MSIX 版の確認・macOS の確認で共通)。
// config.mjs は読み込んだだけで %APPDATA% を求めるので、macOS からも使うものはここに置く

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 中断に備えた控えの記録の置き場所。テストのプロセスの外 (e2e/ 直下。e2e/.gitignore 済み) に置き、
 * Ctrl+C などで後始末が走らなくても、次の回が読んで戻せるようにする
 */
export function recordPath(name) {
	return path.join(E2E_DIR, name);
}

/** 書きかけで止まっても壊れた記録が残らないよう、一時ファイルに書いてから置き換える */
export async function writeJsonAtomic(file, value) {
	const temporary = `${file}.tmp`;
	await fsp.writeFile(temporary, JSON.stringify(value), 'utf8');
	await fsp.rename(temporary, file);
}

/** `writeJsonAtomic` の同期版 (中断のシグナルを受けたときにも使えるように) */
export function writeJsonAtomicSync(file, value) {
	const temporary = `${file}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(value), 'utf8');
	fs.renameSync(temporary, file);
}

/** ファイルの中身。無ければ null で、ほかの失敗は投げる */
export async function readTextIfExists(file) {
	try {
		return await fsp.readFile(file, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

/** `readTextIfExists` の同期版 */
function readTextIfExistsSync(file) {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

/**
 * 中断に備えた JSON の控えを読む。無ければ null、読めない・壊れている・想定外の形なら、
 * 呼び出し元が用意した復旧手順つきのエラーにする
 */
export async function readBackupRecord(file, isValid, invalidMessage) {
	try {
		const text = await readTextIfExists(file);
		if (text === null) return null;
		const record = JSON.parse(text);
		if (!isValid(record)) throw new Error('控えの内容が想定した形をしていません');
		return record;
	} catch (error) {
		throw new Error(invalidMessage, { cause: error });
	}
}

/** `readBackupRecord` の同期版 (中断のシグナルを受けたときにも使えるように) */
export function readBackupRecordSync(file, isValid, invalidMessage) {
	try {
		const text = readTextIfExistsSync(file);
		if (text === null) return null;
		const record = JSON.parse(text);
		if (!isValid(record)) throw new Error('控えの内容が想定した形をしていません');
		return record;
	} catch (error) {
		throw new Error(invalidMessage, { cause: error });
	}
}

export async function fileExists(file) {
	return fsp.access(file).then(
		() => true,
		() => false
	);
}

/** ログの今の大きさ (バイト数)。起動する前に取っておき、`readLogSince` で起動した後の分だけを読む */
export function logSize(file) {
	return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

/**
 * ログのうち、`offset` バイト目から後 (起動した後に書かれた分)。ログは 1 MB で回る (diagnostics.rs) ので、
 * 起動した後に回って `offset` より短くなっていれば、頭から読む。`offset` はバイト数なので、バイト列のまま切る
 */
export function readLogSince(file, offset) {
	if (!fs.existsSync(file)) return '';
	const content = fs.readFileSync(file);
	return content.subarray(content.length < offset ? 0 : offset).toString('utf8');
}
