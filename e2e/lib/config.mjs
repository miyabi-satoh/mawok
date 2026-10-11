import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseToml, stringify as stringifyToml, TomlError } from 'smol-toml';
import {
	AUTOSTART_HELD_ENV,
	discardPowerShell,
	recoverStaleAppsThemeIfAny,
	recoverStaleAutostartBackupIfAny
} from './os.mjs';
import { APP_IDENTIFIER } from './app-conf.mjs';
import {
	fileExists,
	readBackupRecord,
	readTextIfExists,
	recordPath,
	writeJsonAtomic
} from './files.mjs';

// src-tauri/src/lib.rs の app_config_dir() は Tauri (dirs crate 経由の SHGetKnownFolderPath) が
// 決める場所で、環境変数とは厳密には別経路。ただし通常 %APPDATA% とほぼ一致するので、
// home からの組み立て (フォルダーリダイレクト環境だと食い違い、別のファイルを「復元」しかねない)
// より確実な方法として、環境変数から解決する
const appData = process.env.APPDATA;
if (!appData) {
	throw new Error(
		'%APPDATA% が読めませんでした。config.toml の場所を解決できないため E2E を続行できません。'
	);
}
const CONFIG_DIR = path.join(appData, APP_IDENTIFIER);
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.toml');
// 下書きの履歴は、src-tauri/src/lib.rs の app_local_data_dir() の下（Windows は Roaming ではなく %LOCALAPPDATA%）
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
	throw new Error(
		'%LOCALAPPDATA% が読めませんでした。history.json の場所を解決できないため E2E を続行できません。'
	);
}
/** 設定 (%APPDATA%) と、履歴・ログ・WebView2 のデータ (%LOCALAPPDATA%) の置き場所 */
export const APP_DATA_DIRS = Object.freeze({
	roaming: CONFIG_DIR,
	local: path.join(localAppData, APP_IDENTIFIER)
});
const HISTORY_PATH = path.join(APP_DATA_DIRS.local, 'history.json');
// window-state プラグインが、下書きと設定ウィンドウの位置と大きさを記録するファイル。位置や大きさを変えるテストが
// ユーザーの記録を書き換えるので、config.toml と一緒に控えて戻す
export const WINDOW_STATE_PATH = path.join(CONFIG_DIR, '.window-state.json');

// テストが落ちた・Ctrl+C で中断された場合でも、常用の config.toml を壊れたまま残さないための
// 退避ファイル。テストプロセスの外 (e2e/ 直下) に置き、次回実行時に残骸があれば先に復元する
const BACKUP_PATH = recordPath('.config-backup.json');

// 2つの `just e2e` が同時に走ったときに、互いの config.toml を壊し合わないための排他ロック。
// バックアップの有無や pid の生存確認 (recoverStaleBackupIfAny) だけでは、確認してから
// バックアップを作るまでの間に別プロセスが割り込める (TOCTOU) ため、`wx` (排他的な新規作成)
// で原子的に取り合う専用のロックファイルを別に置く
const LOCK_PATH = recordPath('.e2e.lock');

export async function readConfigText() {
	return fs.readFile(CONFIG_PATH, 'utf8');
}

// 設定ファイル (src-tauri/src/config.rs) は、項目名が snake_case で、既定と違う値だけを書く。
// テストは画面とのやり取りと同じ camelCase の名前で読み書きするので、ここで名前を揃え、書いていない項目を既定値で埋める

/** `text_window_keys` → `textWindowKeys` */
function toCamelCase(name) {
	return name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/** `textWindowKeys` → `text_window_keys` */
function toSnakeCase(name) {
	return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** 表の項目名を、入れ子 (text_window_keys や、辞書の行) まで含めて付け替える */
function renameKeys(value, rename) {
	if (Array.isArray(value)) return value.map((item) => renameKeys(item, rename));
	if (value === null || typeof value !== 'object') return value;
	// 表だけを付け替え、日時 (TomlDate) などはそのまま返す。smol-toml は 1.9 から表をプロトタイプの無いオブジェクトで返す
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [rename(key), renameKeys(item, rename)])
	);
}

// src-tauri/src/config.rs の DEFAULT_HOTKEY と同じ値
export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space';

// config.rs の既定値の写し。設定ファイルに書いていない項目は、アプリがこの値で動く
const DEFAULT_CONFIG = {
	hotkey: DEFAULT_HOTKEY,
	autostart: true,
	language: 'system',
	theme: 'system',
	textWindowAlwaysOnTop: true,
	hideTextWindowOnBlur: true,
	showTextWindowButtons: true,
	textHistorySize: 50,
	trimTrailingWhitespace: true,
	replacements: [],
	snippets: [],
	punctuationStyle: 'keep',
	excludeFromClipboardHistory: true,
	textFontFamily: '',
	textFontSize: 16,
	textColorLight: '',
	textColorDark: '',
	devices: [],
	aiService: 'none'
};

// draft_keys.rs の既定のキーの写し
const DEFAULT_DRAFT_KEYS = {
	copy: 'CommandOrControl+Enter',
	send: 'CommandOrControl+Shift+Enter',
	settings: 'CommandOrControl+Comma',
	snippets: 'CommandOrControl+KeyJ',
	actions: 'CommandOrControl+KeyK',
	historyOlder: 'CommandOrControl+Alt+ArrowUp',
	historyNewer: 'CommandOrControl+Alt+ArrowDown',
	sendTargets: 'CommandOrControl+KeyL',
	insertReceived: 'CommandOrControl+KeyI',
	discardReceived: 'CommandOrControl+Shift+Backspace',
	changeFolder: 'CommandOrControl+KeyD'
};

/**
 * 設定ファイルの中身を、camelCase の名前にし、書いていない項目を既定値で埋めて返す。
 * `inputGuidance` は、書いていなければ undefined (既定の案内) のまま
 */
function readConfigFromText(text) {
	const file = renameKeys(parseToml(text), toCamelCase);
	return {
		...DEFAULT_CONFIG,
		...file,
		textWindowKeys: { ...DEFAULT_DRAFT_KEYS, ...file.textWindowKeys },
		replacements: (file.replacements ?? []).map((row) => ({ enabled: true, ...row })),
		devices: (file.devices ?? []).map((row) => ({ sendTo: true, ...row }))
	};
}

/**
 * camelCase の名前で書いた設定を、設定ファイルの TOML にする。null の項目は書かない
 * (TOML には null がない。inputGuidance: null は既定の案内の意味で、項目を書かないのと同じ)
 */
export function toConfigText(config) {
	const written = Object.fromEntries(
		Object.entries(config).filter(([, value]) => value !== null && value !== undefined)
	);
	return stringifyToml(renameKeys(written, toSnakeCase));
}

async function readConfig() {
	return readConfigFromText(await readConfigText());
}

/**
 * 置き換え辞書・定型文・アクションの行から、アプリが付ける `id` と `sync` を外す。
 * テストが渡した中身と比べるときに使う (`id` は行ごとに乱数で付き、`sync` は読む口によって出たり出なかったりする)
 */
export function withoutSyncFields(rows) {
	return rows.map((row) => {
		const rest = { ...row };
		delete rest.id;
		delete rest.sync;
		return rest;
	});
}

/**
 * config.toml をポーリングして待つとき用。アプリは一時ファイルに書いてから差し替えるが、
 * 手で書き換えている最中などで TOML として不完全なことがある。そのタイミングで読んでも
 * テスト全体を失敗させず、単に「まだ条件を満たしていない」として次のポーリングに回す
 */
export async function tryReadConfig() {
	try {
		return await readConfig();
	} catch (error) {
		if (error instanceof TomlError) return undefined;
		throw error;
	}
}

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// 権限がなくて確認できない場合は、安全側に倒して「生きている」扱いにする
		return error.code === 'EPERM';
	}
}

/** 短い間隔を置いて待つ (ロック取得中のプロセスが書き終わるのを待つときに使う) */
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 実行の排他ロックを取る。既に他の実行が持っていて、かつその pid が生きていれば失敗する。
 * ロックの所有者の pid が確認できて、それが死んでいる場合だけ、中断で解放し損ねた残骸と
 * 判断してロックを奪い直す。経過時間だけでは奪わない — pid が生きている限りは、どれだけ
 * 古いロックでも「今も設定を操作しているかもしれない」相手として扱う (実行時間を数時間
 * 超えて止まっている場合、時間で奪うと config.toml の競合が起きうるより、手動での復旧を
 * 求める方が安全)。
 *
 * `wx` (排他的な新規作成) を使うことで、「既に無いことを確認してから作る」を1操作にまとめ、
 * 2つのプロセスが同時に「無い」と判定してしまう競合 (TOCTOU) を避ける。ロック取得直後、
 * 中身の書き込みが終わる前に他プロセスが `EEXIST` で読みに来ると空 (パース不能) に見える
 * ことがあるため、パースできない場合は即座に残骸と決めつけず、少し待って読み直す。
 *
 * 戻り値のトークンは `releaseLock()` に渡すこと。単に `.e2e.lock` を無条件に消すと、
 * 「自分のロックが残骸と判断されて誰かに奪われた後、遅れて自分の後始末が走り、
 * 奪った側のロックを消してしまう」という競合が起きるため、自分が取ったロックだけを
 * 消せるよう識別子で照合する (pid が生きている間は奪わないことと合わせて、この競合は
 * 起きなくなる — 奪えるのは pid が死んでいるときだけで、死んだプロセスは二度と
 * releaseLock を呼ばないため)
 *
 * @returns {Promise<string>} このロックを解放するときに使うトークン
 */
export async function acquireLock() {
	for (;;) {
		const token = randomUUID();
		try {
			const handle = await fs.open(LOCK_PATH, 'wx');
			await handle.writeFile(
				JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token })
			);
			await handle.close();
			return token;
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
		}

		// 既にロックがある。持ち主がまだ生きているか確認する。書き込みの最中で内容が
		// まだ空・不完全に見えることがあるため、数回までは即断せず読み直す
		let owner = null;
		let vanished = false;
		let readable = false;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				owner = JSON.parse(await fs.readFile(LOCK_PATH, 'utf8'));
				readable = true;
				break;
			} catch (error) {
				if (error.code === 'ENOENT') {
					vanished = true; // 別プロセスが既に解放した
					break;
				}
				await delay(100);
			}
		}
		if (vanished) continue; // 無くなっているので、次のループで作成を再試行する
		if (!readable) {
			// 何度読んでも内容が確認できない。書き込みの途中で長く止まっている生きた
			// プロセスの可能性を捨てきれないため、ここで自動的に奪わない。数百msの
			// 停止はまず起きないはずの単純な書き込みなので、それでも読めないのは
			// 何か想定外のことが起きているサインとして、はっきり失敗させる
			throw new Error(
				`${LOCK_PATH} の内容が繰り返し読んでも確認できません。書き込みの途中で長く止まって` +
					'いる実行があるか、何らかの理由でファイルが壊れている可能性があります。' +
					'手動で状況を確認してから、必要であれば削除して再実行してください。'
			);
		}
		if (owner.pid !== process.pid && isProcessAlive(owner.pid)) {
			throw new Error(
				`別の E2E 実行 (pid=${owner.pid}、${owner.startedAt} 開始) が進行中のようです。` +
					`config.toml の競合を避けるため、そちらが終わるのを待ってください。本当に残骸で` +
					`あれば、手動で確認したうえで ${LOCK_PATH} を削除してから再実行してください。`
			);
		}
		// pid が死んでいると確認できたので奪い直す (次のループで作成を再試行する)
		await fs.rm(LOCK_PATH, { force: true });
	}
}

/**
 * 取ったロックを解放する。テストの成否によらず必ず呼ぶこと。
 * `token` が今のロックの中身と一致するときだけ削除する。一致しなければ、既に自分の
 * ロックは残骸として奪われた後なので、他の実行のロックを誤って消さないよう何もしない
 */
export async function releaseLock(token) {
	let current;
	try {
		current = JSON.parse(await fs.readFile(LOCK_PATH, 'utf8'));
	} catch {
		return;
	}
	if (current.token !== token) return;
	await fs.rm(LOCK_PATH, { force: true });
}

/** ファイルの中身を読む。なければ `{ existed: false, text: null }` */
async function readOptionalText(file) {
	const text = await readTextIfExists(file);
	return { existed: text !== null, text };
}

/** 読んだ中身を書き戻す。元々なければ、テスト中にできたファイルを消す */
async function restoreOptionalText(file, { existed, text }) {
	if (existed) {
		await fs.writeFile(file, text, 'utf8');
	} else {
		await fs.rm(file, { force: true });
	}
}

/**
 * config.toml と .window-state.json の今の中身をバックアップファイルに書き、その記録
 * ({ existed, text, windowState: { existed, text } }) を返す。
 * config.toml がまだ存在しない (アプリを一度も起動していないクリーンな環境) 場合も
 * `existed: false` として記録し、復元時にはテスト用に作った config.toml を削除する。
 *
 * 書き込みは一時ファイルに書いてから rename する (途中で強制終了・電源断が起きても
 * 中途半端な内容がバックアップとして残らないようにするため)
 */
async function backupConfigText() {
	const config = await readOptionalText(CONFIG_PATH);
	const history = await readOptionalText(HISTORY_PATH);
	const windowState = await readOptionalText(WINDOW_STATE_PATH);
	const record = {
		savedAt: new Date().toISOString(),
		existed: config.existed,
		text: config.text,
		history,
		windowState
	};
	await writeJsonAtomic(BACKUP_PATH, record);
	return record;
}

function isValidFileRecord(record) {
	return (
		record !== null &&
		typeof record === 'object' &&
		typeof record.existed === 'boolean' &&
		(record.existed ? typeof record.text === 'string' : record.text === null)
	);
}

/** バックアップの記録として最低限の形をしているか (スキーマが不明なものを誤って復元しないため) */
function isValidBackupRecord(record) {
	return (
		isValidFileRecord(record) &&
		typeof record.savedAt === 'string' &&
		// .window-state.json も控えるようになる前の記録には windowState がない
		(record.windowState === undefined || isValidFileRecord(record.windowState)) &&
		(record.history === undefined || isValidFileRecord(record.history))
	);
}

/** 記録を書き戻し (または、元々なければ削除し)、バックアップファイルを消す (正常終了時の後始末) */
async function restoreAndClearBackup({ existed, text, history, windowState }) {
	await restoreOptionalText(CONFIG_PATH, { existed, text });
	if (history) await restoreOptionalText(HISTORY_PATH, history);
	if (windowState) await restoreOptionalText(WINDOW_STATE_PATH, windowState);
	await fs.rm(BACKUP_PATH, { force: true });
}

/** config.toml に中身をそのまま書く (壊れた TOML を試すとき用)。beginTestConfig で控えを取ってから呼ぶこと */
export async function writeConfigText(text) {
	await fs.writeFile(CONFIG_PATH, text, 'utf8');
}

/** E2E のテスト間で下書きの履歴が混ざらないように消す */
export async function clearHistory() {
	await fs.rm(HISTORY_PATH, { force: true });
}

/** 設定フォルダーにある `config.broken-….toml` の名前の一覧 */
export async function listBrokenConfigCopies() {
	const names = await fs.readdir(CONFIG_DIR);
	return names.filter((name) => name.startsWith('config.broken-')).sort();
}

/** 設定フォルダーの `config.broken-….toml` を読む */
export async function readBrokenConfigCopy(name) {
	return fs.readFile(path.join(CONFIG_DIR, name), 'utf8');
}

/** 設定フォルダーの `config.broken-….toml` を消す (テストが作らせたものの後始末) */
export async function removeBrokenConfigCopy(name) {
	if (!name.startsWith('config.broken-'))
		throw new Error(`消せるのは config.broken-….toml だけです: ${name}`);
	await fs.rm(path.join(CONFIG_DIR, name), { force: true });
}

/**
 * 前回の実行が Ctrl+C や強制終了で失敗し、バックアップファイルが残っていれば復元する。
 * 各テストファイルの最初 (acquireLock の後) で呼ぶこと。
 *
 * バックアップの中身が壊れている・想定した形をしていない (書き込み途中で終了した、
 * 前のスキーマのまま残っている等) 場合は、config.toml を誤って書き戻したり消したり
 * しないよう、復元を試みずにはっきり失敗させる
 */
export async function recoverStaleBackupIfAny() {
	const record = await readBackupRecord(
		BACKUP_PATH,
		isValidBackupRecord,
		`${BACKUP_PATH} の内容が壊れているか想定した形をしていないため復元できません。` +
			`config.toml が今どうなっているか手動で確認し、問題なければ ${BACKUP_PATH} を削除してから再実行してください。`
	);
	if (record === null) return false;

	console.warn(
		`[e2e] 前回の実行 (${record.savedAt}) の config.toml バックアップが残っていたので復元します。` +
			'テストが Ctrl+C や強制終了で中断された可能性があります。'
	);
	await restoreAndClearBackup(record);
	return true;
}

let crashRecoveryRegistered = false;
/** 中断時に解放するロック。`--test-isolation=none` で複数ファイルが同じプロセスで動くと、ファイルごとに取り直すので差し替える */
let crashRecoveryLockToken;

/**
 * Ctrl+C (SIGINT) やコンソールの窓を閉じた (SIGHUP) ことでテストが中断された場合に、
 * その時点までのバックアップを復元し、ロックも解放してから終了する。
 * Windows の Node に SIGTERM は届かず、窓を閉じたときに届くのは SIGHUP だけ。しかも Windows は
 * 約10秒後にプロセスを無条件に終わらせるので、それまでに片付けを済ませる必要がある。
 * SIGTERM は Windows 以外で回したとき用に残している。
 * ハンドラの登録はプロセス全体で一度だけで、2回目以降は解放するロックだけを差し替える。
 * `lockToken` は `acquireLock()` の戻り値
 *
 * @param {string} lockToken
 */
export function registerCrashRecovery(lockToken) {
	crashRecoveryLockToken = lockToken;
	if (crashRecoveryRegistered) return;
	crashRecoveryRegistered = true;
	let handling = false;
	const handleSignal = (signal) => {
		// 片付けの最中に別のシグナルが続いても、復元と終了を並行させない
		if (handling) return;
		handling = true;
		// 片付けの最中に次のファイルがロックを取り直しても、中断されたときのロックを解放する
		const lockToken = crashRecoveryLockToken;
		discardPowerShell();
		Promise.all([
			recoverStaleBackupIfAny().catch((error) => {
				console.error('[e2e] 中断時の config.toml 復元に失敗しました:', error);
			}),
			// run.mjs から回すときは、登録の控えは run.mjs のもので、run.mjs が書き戻す (setup.mjs の before と同じ)
			process.env[AUTOSTART_HELD_ENV] === '1'
				? undefined
				: recoverStaleAutostartBackupIfAny().catch((error) => {
						console.error('[e2e] 中断時のログイン時の起動の登録の書き戻しに失敗しました:', error);
					}),
			recoverStaleAppsThemeIfAny().catch((error) => {
				console.error('[e2e] 中断時の Windows の外観の書き戻しに失敗しました:', error);
			})
		]).finally(async () => {
			await releaseLock(lockToken).catch(() => {});
			process.exit(128 + os.constants.signals[signal]);
		});
	};
	for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) {
		process.once(signal, () => handleSignal(signal));
	}
}

/**
 * config.toml がない状態 (初めての起動) にする。今の内容は控えに残し、返ってきた `restore` で戻す
 * (中断されたときの保険は beginTestConfig と同じ)。
 * config.toml がないと、アプリは既定の設定 (ログイン時の起動がオン) で作り直すので、ログイン時の起動の
 * 登録を書き換えることがある。登録の控えと書き戻しは、`just e2e` では run.mjs が全体の前後で1度、直接回すときは setup.mjs の `createSuite` が受け持つ
 *
 * @returns {Promise<{ restore: () => Promise<void> }>}
 */
export async function beginMissingConfig() {
	const original = await backupConfigText();
	await fs.rm(CONFIG_PATH, { force: true });
	return {
		restore: () => restoreAndClearBackup(original)
	};
}

/** config.toml があるか */
export async function configExists() {
	return fileExists(CONFIG_PATH);
}

/**
 * 下書きの履歴のファイル (history.json) にある履歴の件数。ファイルが無ければ 0。
 * 履歴を消した後も、消した時刻を置いたファイルが残るので、ファイルのあるなしでは履歴があるかを見分けられない
 */
export async function historyEntryCount() {
	const { existed, text } = await readOptionalText(HISTORY_PATH);
	if (!existed) return 0;
	try {
		return JSON.parse(text).entries.length;
	} catch {
		// 書き換えの途中で読んだ。待つ側が読み直す
		return 0;
	}
}

/**
 * テスト専用の設定に切り替える (Ctrl+C で中断された場合の保険として、切り替えている間は
 * バックアップファイルにも内容を残す)。`overrides` は今の設定にマージする
 * (language など、テストに関係ない項目はそのまま保つ)。
 *
 * config.toml がまだ存在しない場合は、`overrides` だけからテスト用の設定を作る
 * (このとき設定ディレクトリ自体もまだ無いことがあるので、先に作る)。
 *
 * `autostart` は、今の設定によらず `false` にする (オンで見るテストは overrides かコマンドで入れる)。
 * オンのままだと、E2E が起動するアプリが起動のたびにログイン時の起動を自分のパスで登録し直す
 * (`lib.rs` の settle_autostart。README「E2E はログイン時の起動の登録に触れることがある」)。
 * Rust 側の既定値は `true` なので、書かないとオンになる
 *
 * `overrides` は画面とのやり取りと同じ camelCase の名前で書く。null の項目は書かない (既定値に戻す)
 *
 * `test.before` で呼び、返ってきた `restore` を `test.after` で呼ぶこと
 *
 * @param {Record<string, unknown>} overrides
 * @returns {Promise<{ restore: () => Promise<void> }>}
 */
export async function beginTestConfig(overrides) {
	const original = await backupConfigText();
	await clearHistory();
	const base = original.existed ? renameKeys(parseToml(original.text), toCamelCase) : {};
	// ホットキーと下書きウィンドウのキーは、ユーザーが変えていても既定のキーで回す
	// (テストは Ctrl+Shift+Space や Ctrl+Enter などを押す前提)。変えるテストは overrides で渡す
	const testConfig = {
		...base,
		autostart: false,
		hotkey: DEFAULT_HOTKEY,
		textWindowKeys: null,
		...overrides
	};
	if (!original.existed) {
		await fs.mkdir(CONFIG_DIR, { recursive: true });
	}
	await fs.writeFile(CONFIG_PATH, toConfigText(testConfig), 'utf8');
	return {
		restore: () => restoreAndClearBackup(original)
	};
}
