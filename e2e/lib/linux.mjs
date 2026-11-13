// Linux の確認 (`just linux-check`) で使う、Hyprland・GNOME の上で Mawok を動かして読む道具。
//
// 画面の中は WebDriver (tauri-driver + WebKitWebDriver)、キーは ydotool (uinput)、トレイは D-Bus (dbusmenu)、
// クリップボードは wl-clipboard で扱う。窓とフォーカス・ホットキーの割り当てはデスクトップごとに違うので、
// linux-hyprland.mjs (hyprctl) と linux-gnome.mjs (AT-SPI と gsettings) に分けてある。入れ方は e2e/README.md「Linux の確認」
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { remote } from 'webdriverio';
import { PROFILE, PROFILE_ENV, PROFILE_IDENTIFIER } from './app-conf.mjs';
import { fileExists, markLog, readLogSince, recordPath, writeJsonAtomic } from './files.mjs';
import * as gnome from './linux-gnome.mjs';
import * as hyprland from './linux-hyprland.mjs';
import { writeSettings } from './settings-files.mjs';
import { waitFor } from './wait.mjs';

const execFileAsync = promisify(execFile);

/** 回す Mawok。ビルドはせず、入れてある常用の版で回す (別のものは MAWOK_APP で指す) */
export const APP_PATH = process.env.MAWOK_APP ?? '/usr/bin/mawok';
const PROCESS_NAME = 'mawok';

const CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
const DATA_HOME = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
/** プロファイルを分けた Mawok の設定のフォルダー (Tauri の app_config_dir) */
export const CONFIG_DIR = path.join(CONFIG_HOME, PROFILE_IDENTIFIER);
const DATA_DIR = path.join(DATA_HOME, PROFILE_IDENTIFIER);
export const LOG_PATH = path.join(DATA_DIR, 'logs', 'Mawok.log');
/** ログイン時の起動の .desktop。名前はアプリ名で、プロファイルでは分かれない (docs/platform.md「プロファイル」) */
export const AUTOSTART_FILE = path.join(CONFIG_HOME, 'autostart', 'Mawok.desktop');
// portal は、名乗ったアプリ ID の .desktop が無いと登録を断る (`App info not found`)。常用の版はパッケージが入れるが、
// プロファイルを分けた ID には無いので、回している間だけ置く
const PORTAL_DESKTOP_FILE = path.join(DATA_HOME, 'applications', `${PROFILE_IDENTIFIER}.desktop`);

const BACKUP_DIR = recordPath('.linux-backup');
/** 落ちたときの画面と窓の一覧の置き場 (`screenshots/` は gitignore 済み) */
export const FAILURE_DIR = path.resolve(import.meta.dirname, '..', 'screenshots', 'linux-failures');

const YDOTOOL_SOCKET =
	process.env.YDOTOOL_SOCKET ?? `/run/user/${process.getuid()}/.ydotool_socket`;

/** Linux の入力のキーコード (linux/input-event-codes.h) */
export const KEY = {
	esc: 1,
	enter: 28,
	ctrl: 29,
	shift: 42,
	alt: 56,
	space: 57,
	m: 50
};

// ── 環境 ──

/** 回しているデスクトップの扱い (linux-hyprland.mjs・linux-gnome.mjs)。ensureSessionEnv で決まる */
let desktop;

/**
 * 回しているデスクトップを見分け、その扱いを選ぶ。エージェントや ssh から回すと、Wayland などの環境変数が無いことがあるので、
 * ログインした画面のものを足す。どちらでもなければ投げる
 */
export async function ensureSessionEnv() {
	if (desktop) return desktop;
	const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;
	process.env.XDG_RUNTIME_DIR = runtime;
	await importSessionEnv();
	for (const candidate of [hyprland, gnome]) {
		if (await candidate.detect(runtime)) {
			desktop = candidate;
			break;
		}
	}
	if (!desktop) throw new Error('Hyprland か GNOME の上で回してください (どちらも動いていません)');
	process.env.YDOTOOL_SOCKET = YDOTOOL_SOCKET;
	return desktop;
}

// ログインした画面のセッションが systemd に渡している環境変数のうち、Mawok が要るもの。DISPLAY が無いと、
// data-control の無いデスクトップ (GNOME) で arboard が X11 (Xwayland) のクリップボードに切り替えられず、コピーが失敗する
const SESSION_ENV = [
	'WAYLAND_DISPLAY',
	'DISPLAY',
	'XAUTHORITY',
	'XDG_CURRENT_DESKTOP',
	'XDG_SESSION_TYPE',
	'DBUS_SESSION_BUS_ADDRESS'
];

/** ssh などから回すときに、無い環境変数をセッションのものから足す */
async function importSessionEnv() {
	const { stdout } = await execFileAsync('systemctl', ['--user', 'show-environment']).catch(() => ({
		stdout: ''
	}));
	for (const line of stdout.split('\n')) {
		const eq = line.indexOf('=');
		const name = line.slice(0, eq);
		if (eq > 0 && SESSION_ENV.includes(name) && !process.env[name]) {
			process.env[name] = line.slice(eq + 1);
		}
	}
}

/** 回しているデスクトップの名前 (`hyprland`・`gnome`) */
export function desktopName() {
	return desktop?.name;
}

/** 回す前に、要る道具と状態を確かめる。足りなければ、直し方を書いて投げる */
export async function preflight() {
	await ensureSessionEnv();
	const missing = [];
	for (const [command, how] of [
		['ydotool', 'ydotool のパッケージを入れる'],
		['wl-paste', 'wl-clipboard のパッケージを入れる'],
		['busctl', 'systemd に含まれる'],
		['tauri-driver', 'cargo install tauri-driver --locked'],
		['WebKitWebDriver', 'Arch は webkitgtk-6.0、Ubuntu は webkitgtk-webdriver のパッケージ'],
		...desktop.tools
	]) {
		if (!(await which(command))) missing.push(`${command} (${how})`);
	}
	if (!(await fileExists(APP_PATH))) missing.push(`${APP_PATH} (常用の Mawok を入れる)`);
	if (missing.length > 0) throw new Error(`道具が足りません: ${missing.join('、')}`);
	if (!(await fileExists(YDOTOOL_SOCKET))) {
		throw new Error(
			`ydotoold が動いていません (${YDOTOOL_SOCKET} がありません)。別の端末で ` +
				`sudo ydotoold --socket-path=${YDOTOOL_SOCKET} --socket-own=$(id -u):$(id -g) を動かしてください`
		);
	}
	await desktop.preflight({ ydotool, sleep });
}

/** PATH から実行ファイルを探す (`which` が入っていない環境があるので自分で探す)。無ければ null */
async function which(command) {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		const file = path.join(dir, command);
		if (
			await fs.access(file, fs.constants.X_OK).then(
				() => true,
				() => false
			)
		)
			return file;
	}
	return null;
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 窓とフォーカス・ホットキーの割り当て (デスクトップごと) ──

/** Mawok の窓 (見えているもの)。`title` で絞れる */
export async function mawokWindows(title) {
	return (await desktop.windows()).filter(
		(w) => w.app === 'mawok' && (title === undefined || w.title === title)
	);
}

/** フォーカスのある窓 (`{ app, title }`)。無ければ null */
export function activeWindow() {
	return desktop.activeWindow();
}

/** portal に登録できたホットキーがデスクトップの一覧にあるか。読めないデスクトップでは null */
/**
 * デスクトップの portal に GlobalShortcuts があるか (GNOME 47 までは無い)。Mawok のログの「登録できなかった」は、
 * portal が無いときにも登録が失敗したときにも出るので、こちらで見分ける
 */
export async function hasGlobalShortcutsPortal() {
	return (
		await busctl([
			'introspect',
			'org.freedesktop.portal.Desktop',
			'/org/freedesktop/portal/desktop'
		])
	).includes('org.freedesktop.portal.GlobalShortcuts');
}

export function portalShortcutRegistered() {
	return desktop.portalShortcutRegistered();
}

/** 押すと下書きを出し入れするキーの組み合わせ (bindHotkey で決まる) */
let hotkeyChord = ['ctrl', 'shift', 'space'];

/** ホットキーを、確かめる道に向ける。`portal` は portal の登録へ、`toggle` は `mawok --toggle` へ */
export async function bindHotkey(mode) {
	hotkeyChord = await desktop.bindHotkey(mode, APP_PATH);
}

export function unbindHotkey() {
	return desktop.unbindHotkey();
}

// ── ydotool ──

function ydotool(args) {
	return execFileAsync('ydotool', args, { env: { ...process.env, YDOTOOL_SOCKET } });
}

/** キーを押して離す。`codes` は同時に押す組み合わせ (押した逆の順に離す) */
export async function pressKeys(...codes) {
	const down = codes.map((code) => `${code}:1`);
	const up = [...codes].reverse().map((code) => `${code}:0`);
	await ydotool(['key', '--key-delay', '30', ...down, ...up]);
}

export async function pressHotkey() {
	await pressKeys(...hotkeyChord.map((name) => KEY[name]));
}

/** ASCII の文字を打つ */
export async function typeText(text) {
	await ydotool(['type', '--key-delay', '20', text]);
}

// ── クリップボード ──

export async function clipboardText() {
	try {
		return (await execFileAsync('wl-paste', ['-n', '-t', 'text/plain;charset=utf-8'])).stdout;
	} catch {
		return null;
	}
}

export async function clipboardTypes() {
	try {
		return (await execFileAsync('wl-paste', ['--list-types'])).stdout.trim().split('\n');
	} catch {
		return [];
	}
}

/** クリップボードに文字を置く。wl-copy は中身を配るために裏で残る */
export async function setClipboard(text) {
	await new Promise((resolve, reject) => {
		const child = spawn('wl-copy', [], { stdio: ['pipe', 'ignore', 'inherit'] });
		child.once('error', reject);
		child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`wl-copy: ${code}`))));
		child.stdin.end(text);
	});
}

// ── トレイ (StatusNotifierItem と dbusmenu) ──

async function busctl(args) {
	// `--` の後は引数として読ませる (GetLayout の -1 をオプションと読まれないよう)
	return (await execFileAsync('busctl', ['--user', '--json=short', '--', ...args])).stdout;
}

/** 動いている Mawok (プロファイルを分けたもの) のトレイのアイコンの、D-Bus の名前とメニューのパス */
export async function trayItem() {
	const pids = await mawokPids();
	const items = JSON.parse(
		await busctl([
			'get-property',
			'org.kde.StatusNotifierWatcher',
			'/StatusNotifierWatcher',
			'org.kde.StatusNotifierWatcher',
			'RegisteredStatusNotifierItems'
		])
	).data;
	for (const item of items) {
		// `<バス名>/<パス>` (Hyprland のパネル) と `<バス名>@<パス>` (GNOME の AppIndicator の拡張) がある
		const split = item.search(/[@/]/);
		const [bus, object] =
			split < 0
				? [item, '/StatusNotifierItem']
				: [item.slice(0, split), item.slice(item[split] === '@' ? split + 1 : split)];
		const pid = await busctl([
			'call',
			'org.freedesktop.DBus',
			'/org/freedesktop/DBus',
			'org.freedesktop.DBus',
			'GetConnectionUnixProcessID',
			's',
			bus
		])
			.then((out) => JSON.parse(out).data[0])
			.catch(() => null);
		if (!pids.includes(pid)) continue;
		const menu = JSON.parse(
			await busctl(['get-property', bus, object, 'org.kde.StatusNotifierItem', 'Menu'])
		).data;
		return { bus, object, menu };
	}
	return null;
}

/** トレイのメニューの項目。区切りは `label: null` */
export async function trayMenu() {
	const item = await trayItem();
	if (!item) throw new Error('Mawok のトレイのアイコンが見つかりません');
	const layout = JSON.parse(
		await busctl([
			'call',
			item.bus,
			item.menu,
			'com.canonical.dbusmenu',
			'GetLayout',
			'iias',
			'0',
			'-1',
			'3',
			'label',
			'type',
			'enabled'
		])
	).data[1];
	// (id, { 項目 }, [子]) の入れ子。子は variant に包まれている
	return layout[2].map(({ data: [id, props] }) => ({
		id,
		label: props.type?.data === 'separator' ? null : (props.label?.data ?? null),
		enabled: props.enabled?.data ?? true
	}));
}

/** トレイのメニューの項目を、名前で押す */
export async function pressTrayItem(label) {
	const item = await trayItem();
	const entry = (await trayMenu()).find((e) => e.label === label);
	if (!entry) throw new Error(`トレイのメニューに「${label}」がありません`);
	await busctl([
		'call',
		item.bus,
		item.menu,
		'com.canonical.dbusmenu',
		'Event',
		'isvu',
		String(entry.id),
		'clicked',
		's',
		'',
		'0'
	]);
}

// ── Mawok のプロセス ──

export async function mawokPids() {
	try {
		const { stdout } = await execFileAsync('pgrep', ['-x', PROCESS_NAME]);
		return stdout.trim().split('\n').map(Number);
	} catch (error) {
		if (error.code === 1) return [];
		throw error;
	}
}

async function isMawokRunning() {
	return (await mawokPids()).length > 0;
}

export async function quitMawok() {
	if (!(await isMawokRunning())) return;
	await execFileAsync('pkill', ['-x', PROCESS_NAME]).catch(() => {});
	await waitFor(isMawokRunning, (running) => !running, { timeout: 10_000, label: 'Mawok の終了' });
}

/** 常用の Mawok を、ログインしたときと同じように起動する */
async function launchRegularMawok() {
	desktop.launchRegular(APP_PATH);
	await waitFor(isMawokRunning, Boolean, { timeout: 10_000, label: '常用の Mawok の起動' });
}

// ── 利用者の状態の控え ──

/**
 * 常用の Mawok を終了し、ログイン時の起動の .desktop とクリップボードの文字を控える。回している間は、
 * ログイン時の起動の .desktop を外し (テストの Mawok が書き換えるため)、portal に名乗るための .desktop を置く。
 * 前に中断されて控えが残っていれば、先にそれを戻す
 */
export async function holdUserState() {
	if (await fileExists(BACKUP_DIR)) {
		console.warn('[linux-check] 前に中断された控えが残っていたので、先に戻します');
		await restoreUserState();
	}
	await fs.mkdir(BACKUP_DIR, { recursive: true });
	const wasRunning = await isMawokRunning();
	// 控えを取り終える前に止まっても、動いていた Mawok を起動し直せるよう、先に書いておく
	await writeJsonAtomic(path.join(BACKUP_DIR, 'running.json'), { wasRunning });
	await quitMawok();
	const autostart = await fs.readFile(AUTOSTART_FILE, 'utf8').catch(() => null);
	const types = await clipboardTypes();
	const clipboard = types.some((t) => t.startsWith('text/plain')) ? await clipboardText() : null;
	const held = await desktop.hold();
	await writeJsonAtomic(path.join(BACKUP_DIR, 'state.json'), {
		wasRunning,
		autostart,
		clipboard,
		desktop: held
	});
	await fs.rm(AUTOSTART_FILE, { force: true });
	await fs.mkdir(path.dirname(PORTAL_DESKTOP_FILE), { recursive: true });
	await fs.writeFile(
		PORTAL_DESKTOP_FILE,
		`[Desktop Entry]\nType=Application\nName=Mawok (${PROFILE})\nExec=${APP_PATH}\nNoDisplay=true\n`
	);
}

/** 控えた状態に戻す。控えたときに Mawok が動いていたかを返す (控えが無ければ null) */
export async function restoreUserState() {
	if (!(await fileExists(BACKUP_DIR))) return null;
	await quitMawok();
	await fs.rm(PORTAL_DESKTOP_FILE, { force: true });
	const stateFile = path.join(BACKUP_DIR, 'state.json');
	const state = await fs.readFile(stateFile, 'utf8').then(JSON.parse, () => null);
	await desktop
		.restore(state?.desktop)
		.catch((error) =>
			console.warn(`[linux-check] ホットキーの割り当てを戻せませんでした: ${error.message}`)
		);
	const running =
		state ??
		(await fs.readFile(path.join(BACKUP_DIR, 'running.json'), 'utf8').then(JSON.parse, () => ({
			wasRunning: false
		})));
	if (state) {
		if (state.autostart === null) await fs.rm(AUTOSTART_FILE, { force: true });
		else {
			await fs.mkdir(path.dirname(AUTOSTART_FILE), { recursive: true });
			await fs.writeFile(AUTOSTART_FILE, state.autostart);
		}
		if (state.clipboard !== null) await setClipboard(state.clipboard).catch(() => {});
	}
	await fs.rm(BACKUP_DIR, { recursive: true, force: true });
	if (running.wasRunning) await launchRegularMawok();
	return running.wasRunning;
}

// ── WebDriver ──

function isListening(port) {
	return new Promise((resolve) => {
		const socket = net.createConnection({ port, host: '127.0.0.1' });
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => {
			socket.destroy();
			resolve(false);
		});
	});
}

/** tauri-driver を、WebKitWebDriver を使うように起動する。アプリはこの環境変数を引き継ぐ */
export async function startDriver({ port = 4444, nativePort = 4445 } = {}) {
	for (const p of [port, nativePort]) {
		if (await isListening(p)) {
			throw new Error(
				`ポート ${p} は既に使われています。前の tauri-driver か WebKitWebDriver が残っていれば終了してください`
			);
		}
	}
	// tauri-driver は名前では探さないので、パスで渡す
	const nativeDriver = await which('WebKitWebDriver');
	const child = spawn(
		'tauri-driver',
		['--port', String(port), '--native-port', String(nativePort), '--native-driver', nativeDriver],
		{ stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, [PROFILE_ENV]: PROFILE } }
	);
	const exited = new Promise((resolve) => child.once('exit', resolve));
	const stop = async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await exited;
		await execFileAsync('pkill', ['-x', 'WebKitWebDriver']).catch(() => {});
	};
	try {
		await waitFor(
			async () => {
				if (child.exitCode !== null)
					throw new Error(`tauri-driver が起動前に終了しました (code=${child.exitCode})`);
				return (await isListening(port)) && (await isListening(nativePort));
			},
			Boolean,
			{ timeout: 15_000, interval: 200, label: 'tauri-driver の起動' }
		);
	} catch (error) {
		// 残すとポートを塞ぎ、後のテストファイルがどれも起動できなくなる
		await stop();
		throw error;
	}
	return { port, stop };
}

/**
 * 設定を書いて、Mawok を WebDriver から起動する。`settings` は camelCase の名前で書いた設定で、置き場をそっくり置き換える
 * (settings-files.mjs)。ログイン時の起動は、指定しなければオフ (利用者の .desktop を書き換えないため)。
 * 画面の読み込みが終わるまで待ってから返す
 */
export async function launchApp(driver, settings = {}) {
	await quitMawok();
	await writeSettings(CONFIG_DIR, { autostart: false, language: 'ja', ...settings });
	const mark = markLog(LOG_PATH);
	const client = await remote({
		hostname: '127.0.0.1',
		port: driver.port,
		logLevel: 'warn',
		capabilities: {
			'wdio:enforceWebDriverClassic': true,
			'tauri:options': { application: APP_PATH }
		}
	});
	try {
		// portal への登録の結果 (できた・できなかった) が出るまで待つ。GNOME は初めてのアプリ ID に確かめの画面を出し、
		// 出たままだとフォーカスを取ってほかのテストを乱すので、出ていれば足すほうを押す
		await waitFor(
			async () => {
				if (readLogSince(LOG_PATH, mark).includes('with the desktop portal')) return true;
				await desktop.approvePortalShortcut();
				return false;
			},
			Boolean,
			{ timeout: 20_000, interval: 500, label: 'portal への登録の結果' }
		);
		await waitFor(
			() => readLogSince(LOG_PATH, mark),
			(log) => log.includes('page ready (main '),
			{
				timeout: 15_000,
				interval: 200,
				label: '下書きの画面の読み込み'
			}
		);
	} catch (error) {
		await closeApp(client);
		if (readLogSince(LOG_PATH, mark) === '') {
			throw new Error(
				`起動した Mawok が ${PROFILE_ENV} を見ていません (${LOG_PATH} にログが書かれません)`,
				{ cause: error }
			);
		}
		throw error;
	}
	return { client, mark };
}

/** WebDriver のセッションを閉じ、Mawok が残っていれば終了する */
export async function closeApp(client) {
	await client?.deleteSession().catch(() => {});
	await quitMawok();
}

/** 起動してからのログ */
export function logSince(mark) {
	return readLogSince(LOG_PATH, mark);
}

/** ログに `text` が出るまで待つ */
export function waitLog(mark, text, label = `ログの「${text}」`) {
	return waitFor(
		() => readLogSince(LOG_PATH, mark),
		(log) => log.includes(text),
		{
			timeout: 10_000,
			interval: 200,
			label
		}
	);
}

/** 画面と同じコマンドを、今の窓の画面から呼ぶ */
export function invoke(client, command, args = {}) {
	return client.execute((c, a) => window.__TAURI_INTERNALS__.invoke(c, a), command, args);
}

/** 下書きの入力欄にフォーカスがあるか */
export async function draftFocused(client) {
	return client.execute(() => document.activeElement === document.querySelector('textarea'));
}

/** 下書きの窓が見えているか (デスクトップの窓の一覧で) */
export async function isDraftVisible() {
	return (await mawokWindows('Mawok')).length > 0;
}

export function waitDraftVisible(visible, label) {
	return waitFor(isDraftVisible, (v) => v === visible, {
		timeout: 5_000,
		label: label ?? (visible ? '下書きの窓が出る' : '下書きの窓が隠れる')
	});
}

// ── ほかの窓 ──

/**
 * 下書きを隠した後にフォーカスが戻る先として、ほかのアプリの窓を1つ開いて前面にする。返すものの `app` は
 * activeWindow の `app` と比べる名前、`focus` で前面に戻し、`close` で閉じる
 */
export function launchOtherWindow() {
	return desktop.launchOtherWindow();
}

// ── 落ちたときの記録 ──

/** 落ちた時点の画面と、窓の一覧とフォーカスを `FAILURE_DIR` に置き、置いた先を返す。どれも投げない */
export async function captureFailure(name) {
	try {
		await fs.mkdir(FAILURE_DIR, { recursive: true });
	} catch (error) {
		console.error(`[linux-check] 記録の置き場を作れませんでした: ${error.message}`);
		return [];
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const base = path.join(
		FAILURE_DIR,
		`${stamp} ${name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80)}`
	);
	const saved = [];
	try {
		await desktop.screenshot(`${base}.png`);
		saved.push(`${base}.png`);
	} catch (error) {
		console.error(`[linux-check] 画面を撮れませんでした: ${error.message}`);
	}
	try {
		const state = await desktop.state();
		await fs.writeFile(`${base}.json`, `${JSON.stringify(state, null, '\t')}\n`);
		saved.push(`${base}.json`);
	} catch (error) {
		console.error(`[linux-check] 窓の一覧を読めませんでした: ${error.message}`);
	}
	return saved;
}
