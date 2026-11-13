// Linux の確認 (`just linux-check`) で使う、Hyprland の上で Mawok を動かして読む道具。
//
// 画面の中は WebDriver (tauri-driver + WebKitWebDriver)、キーは ydotool (uinput)、トレイは D-Bus (dbusmenu)、
// 窓とフォーカスは hyprctl、クリップボードは wl-clipboard で扱う。入れ方は e2e/README.md「Linux の確認」
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { remote } from 'webdriverio';
import { PROFILE, PROFILE_ENV, PROFILE_IDENTIFIER } from './app-conf.mjs';
import { fileExists, markLog, readLogSince, recordPath, writeJsonAtomic } from './files.mjs';
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
/** portal に登録したホットキーの、Hyprland での名前 (`hyprctl globalshortcuts`)。portal_hotkey.rs の SHORTCUT_ID */
export const PORTAL_SHORTCUT = `${PROFILE_IDENTIFIER}:toggle`;

const BACKUP_DIR = recordPath('.linux-backup');
/** 落ちたときの画面と窓の一覧の置き場 (`screenshots/` は gitignore 済み) */
export const FAILURE_DIR = path.resolve(import.meta.dirname, '..', 'screenshots', 'linux-failures');

const YDOTOOL_SOCKET =
	process.env.YDOTOOL_SOCKET ?? `/run/user/${process.getuid()}/.ydotool_socket`;
// ydotoold が作る仮想の装置。keyd が掴むと、送ったキーが Hyprland に届かない
const YDOTOOL_DEVICE_ID = '2333:6666';

/** 既定のホットキー (Aero の Hyprland の割り当てと同じ) */
const HOTKEY = 'CTRL + SHIFT + SPACE';
const OTHER_CLASS = 'mawok-e2e-other';

/** Linux の入力のキーコード (linux/input-event-codes.h) */
export const KEY = {
	esc: 1,
	enter: 28,
	ctrl: 29,
	shift: 42,
	space: 57,
	j: 36,
	comma: 51
};

// ── 環境 ──

/**
 * エージェントやほかの端末から回すと、Wayland と Hyprland の環境変数が無いことがある。ログインした画面のものを探して足す。
 * 見つからなければ投げる
 */
export async function ensureSessionEnv() {
	const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;
	if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) {
		const instances = await fs.readdir(path.join(runtime, 'hypr')).catch(() => []);
		if (instances.length !== 1) {
			throw new Error(
				instances.length === 0
					? 'Hyprland が動いていません (この確認は Hyprland の上で回します)'
					: `Hyprland が ${instances.length} つ動いています。HYPRLAND_INSTANCE_SIGNATURE で選んでください`
			);
		}
		process.env.HYPRLAND_INSTANCE_SIGNATURE = instances[0];
	}
	if (!process.env.WAYLAND_DISPLAY) {
		const instance = await hyprctlJson('instances');
		const socket = instance.find(
			(i) => i.instance === process.env.HYPRLAND_INSTANCE_SIGNATURE
		)?.wl_socket;
		if (!socket) throw new Error('Hyprland の Wayland のソケットが分かりません');
		process.env.WAYLAND_DISPLAY = socket;
	}
	process.env.YDOTOOL_SOCKET = YDOTOOL_SOCKET;
}

/** 回す前に、要る道具と状態を確かめる。足りなければ、直し方を書いて投げる */
export async function preflight() {
	await ensureSessionEnv();
	const missing = [];
	for (const [command, how] of [
		['ydotool', 'sudo pacman -S ydotool'],
		['wl-paste', 'sudo pacman -S wl-clipboard'],
		['grim', 'sudo pacman -S grim'],
		['busctl', 'systemd に含まれる'],
		['tauri-driver', 'cargo install tauri-driver --locked'],
		['WebKitWebDriver', 'sudo pacman -S webkitgtk-6.0']
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
	await assertKeydIgnoresYdotool();
	await assertPointerOnThisScreen();
}

async function which(command) {
	try {
		await execFileAsync('which', [command]);
		return true;
	} catch {
		return false;
	}
}

/** keyd が動いていて ydotool の装置も掴むと、送ったキーが消える (マウスは届く) */
async function assertKeydIgnoresYdotool() {
	const active = await execFileAsync('systemctl', ['is-active', 'keyd']).then(
		() => true,
		() => false
	);
	if (!active) return;
	const configs = await fs.readdir('/etc/keyd').catch(() => []);
	for (const name of configs.filter((n) => n.endsWith('.conf'))) {
		const text = await fs.readFile(path.join('/etc/keyd', name), 'utf8').catch(() => '');
		const ids = text.split(/^\[/m).find((section) => section.startsWith('ids]')) ?? '';
		const lines = ids.split('\n').map((line) => line.trim());
		if (lines.includes('*') && !lines.includes(`-${YDOTOOL_DEVICE_ID}`)) {
			throw new Error(
				`keyd が ydotool の装置を掴みます。/etc/keyd/${name} の [ids] に -${YDOTOOL_DEVICE_ID} を足し、` +
					'sudo systemctl restart keyd してください (keyd reload は落ちることがある)'
			);
		}
	}
}

/**
 * ポインターがこの画面にあるか。Deskflow のサーバーでポインターがほかの機に移っていると、ydotool のキーもポインターも
 * そちらへ送られる。ydotool でポインターを少し動かし、Hyprland のポインターが動くかで見る
 */
async function assertPointerOnThisScreen() {
	const before = await cursorPosition();
	await ydotool(['mousemove', '-x', '5', '-y', '5']);
	await sleep(200);
	const after = await cursorPosition();
	await ydotool(['mousemove', '-x', '-5', '-y', '-5']);
	if (before.x === after.x && before.y === after.y) {
		throw new Error(
			'ydotool でポインターが動きません。Deskflow でポインターがほかの機に移っていれば、この機の画面に戻してください'
		);
	}
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── hyprctl ──

async function hyprctl(args) {
	const { stdout } = await execFileAsync('hyprctl', args);
	return stdout;
}

async function hyprctlJson(what) {
	return JSON.parse(await hyprctl(['-j', what]));
}

/** Hyprland の Lua の設定に式を渡して動かす */
async function hyprEval(code) {
	const out = (await hyprctl(['eval', code])).trim();
	if (out !== 'ok') throw new Error(`hyprctl eval が失敗しました: ${code}: ${out}`);
}

export async function cursorPosition() {
	const [x, y] = (await hyprctl(['cursorpos'])).trim().split(/,\s*/).map(Number);
	return { x, y };
}

/** Mawok の窓 (見えているもの)。`title` で絞れる */
export async function mawokWindows(title) {
	return (await hyprctlJson('clients')).filter(
		(c) => c.class === 'mawok' && !c.hidden && (title === undefined || c.title === title)
	);
}

/** フォーカスのある窓。無ければ null */
export async function activeWindow() {
	const active = await hyprctlJson('activewindow');
	return active?.address
		? { class: active.class, title: active.title, address: active.address }
		: null;
}

/** ポインターを画面の座標へ動かす (ydotool の相対移動は加速が掛かって狙えないので Hyprland に頼む) */
export async function moveCursor({ x, y }) {
	await hyprEval(`hl.dispatch(hl.dsp.cursor.move({ x = ${Math.round(x)}, y = ${Math.round(y)} }))`);
}

/** Hyprland のホットキーの割り当てを、確かめる道に替える。`portal` は portal の登録へ、`toggle` は `mawok --toggle` へ */
export async function bindHotkey(mode) {
	await unbindHotkey();
	const action =
		mode === 'portal'
			? `hl.dsp.global("${PORTAL_SHORTCUT}")`
			: `hl.dsp.exec_cmd("env ${PROFILE_ENV}=${PROFILE} ${APP_PATH} --toggle")`;
	await hyprEval(`hl.bind("${HOTKEY}", ${action})`);
}

export async function unbindHotkey() {
	await hyprEval(`hl.unbind("${HOTKEY}")`);
}

/** Hyprland の設定を読み直して、割り当てを利用者のものに戻す */
async function reloadHyprland() {
	await hyprctl(['reload']);
}

/** portal に登録されたホットキーの名前の一覧 (`<アプリ ID>:<id>`) */
export async function globalShortcuts() {
	const out = await hyprctl(['globalshortcuts']);
	return out
		.split('\n')
		.map((line) => line.split(' -> ')[0].trim())
		.filter(Boolean);
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
	await pressKeys(KEY.ctrl, KEY.shift, KEY.space);
}

/** ASCII の文字を打つ */
export async function typeText(text) {
	await ydotool(['type', '--key-delay', '20', text]);
}

/** 画面の座標を左クリックする */
export async function clickAt(point) {
	await moveCursor(point);
	await sleep(150);
	await ydotool(['click', '0xC0']);
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
		const slash = item.indexOf('/');
		const [bus, object] =
			slash < 0 ? [item, '/StatusNotifierItem'] : [item.slice(0, slash), item.slice(slash)];
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

/** 常用の Mawok を、ログインしたときと同じく uwsm の下で起動する */
async function launchRegularMawok() {
	const child = spawn('setsid', ['-f', 'uwsm-app', '--', APP_PATH], {
		stdio: 'ignore',
		detached: true
	});
	child.unref();
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
	await writeJsonAtomic(path.join(BACKUP_DIR, 'state.json'), { wasRunning, autostart, clipboard });
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
	await reloadHyprland().catch((error) =>
		console.warn(`[linux-check] Hyprland の設定を読み直せませんでした: ${error.message}`)
	);
	await fs.rm(PORTAL_DESKTOP_FILE, { force: true });
	const stateFile = path.join(BACKUP_DIR, 'state.json');
	const state = await fs.readFile(stateFile, 'utf8').then(JSON.parse, () => null);
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
	const nativeDriver = (await execFileAsync('which', ['WebKitWebDriver'])).stdout.trim();
	const child = spawn(
		'tauri-driver',
		['--port', String(port), '--native-port', String(nativePort), '--native-driver', nativeDriver],
		{ stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, [PROFILE_ENV]: PROFILE } }
	);
	const exited = new Promise((resolve) => child.once('exit', resolve));
	await waitFor(
		async () => {
			if (child.exitCode !== null)
				throw new Error(`tauri-driver が起動前に終了しました (code=${child.exitCode})`);
			return (await isListening(port)) && (await isListening(nativePort));
		},
		Boolean,
		{ timeout: 15_000, interval: 200, label: 'tauri-driver の起動' }
	);
	return {
		port,
		async stop() {
			if (child.exitCode === null && child.signalCode === null) child.kill();
			await exited;
			await execFileAsync('pkill', ['-x', 'WebKitWebDriver']).catch(() => {});
		}
	};
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
	await captureIfFailed();
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

/** WebDriver の今の窓を、題で選ぶ */
export async function switchToWindow(client, title) {
	await waitFor(
		async () => {
			for (const handle of await client.getWindowHandles()) {
				await client.switchToWindow(handle);
				if ((await client.getTitle()) === title) return true;
			}
			return false;
		},
		Boolean,
		{ timeout: 10_000, interval: 300, label: `「${title}」の窓` }
	);
}

/** 下書きの入力欄の中身 */
export async function draftValue(client) {
	return client.execute(() => document.querySelector('textarea').value);
}

/** 下書きの入力欄にフォーカスがあるか */
export async function draftFocused(client) {
	return client.execute(() => document.activeElement === document.querySelector('textarea'));
}

/** 下書きの窓が見えているか (Hyprland で) */
export async function isDraftVisible() {
	return (await mawokWindows('Mawok')).length > 0;
}

export function waitDraftVisible(visible, label) {
	return waitFor(isDraftVisible, (v) => v === visible, {
		timeout: 5_000,
		label: label ?? (visible ? '下書きの窓が出る' : '下書きの窓が隠れる')
	});
}

/**
 * 画面の中の要素の、画面の座標での中心。窓の位置は Hyprland から、窓の中の位置は WebDriver から読む。
 * 窓の中の CSS ピクセルと、Hyprland の論理ピクセルの比は、窓の幅で合わせる
 */
export async function elementScreenCenter(client, selector, title = 'Mawok') {
	const [win] = await mawokWindows(title);
	if (!win) throw new Error(`「${title}」の窓が見えていません`);
	const box = await client.execute((sel) => {
		const rect = document.querySelector(sel).getBoundingClientRect();
		return {
			x: rect.x + rect.width / 2,
			y: rect.y + rect.height / 2,
			width: innerWidth,
			height: innerHeight
		};
	}, selector);
	const scale = win.size[0] / box.width;
	return { x: win.at[0] + box.x * scale, y: win.at[1] + box.y * scale };
}

// ── ほかの窓 ──

/**
 * 下書きを隠した後にフォーカスが戻る先として、端末を1つ開いてフォーカスを渡す。`close` で閉じる
 */
export async function launchOtherWindow() {
	const child = spawn('foot', ['--app-id', OTHER_CLASS, 'sleep', '600'], {
		stdio: 'ignore',
		detached: true
	});
	child.unref();
	const win = await waitFor(
		async () => (await hyprctlJson('clients')).find((c) => c.class === OTHER_CLASS) ?? null,
		Boolean,
		{ timeout: 10_000, label: 'ほかの窓が開く' }
	);
	await hyprEval(`hl.dispatch(hl.dsp.focus({ window = "address:${win.address}" }))`).catch(
		() => {}
	);
	return {
		class: OTHER_CLASS,
		async focus() {
			await hyprEval(`hl.dispatch(hl.dsp.focus({ window = "address:${win.address}" }))`);
		},
		async close() {
			try {
				process.kill(child.pid);
			} catch {
				// 閉じていてもよい
			}
		}
	};
}

// ── 落ちたときの記録 ──

let currentTest;
let capturedCurrent = false;

/** 回り始めたテストを覚える (linux-failure-capture.mjs の beforeEach から呼ぶ) */
export function trackTest(t) {
	currentTest = t;
	capturedCurrent = false;
}

/**
 * 回っているテストの本体が落ちていたら、1度だけ記録を残す。テストファイルの後始末は Mawok を閉じる (closeApp) ので、
 * 全体の afterEach だけでは Mawok の窓が写らない。閉じる前にも呼ぶ。落ちたかは passed でなく error で見る
 * (passed は本体が終わるまで false なので、本体の途中で起動し直すテストで、通るテストまで記録してしまう)
 */
export async function captureIfFailed() {
	if (!currentTest?.error || capturedCurrent) return;
	capturedCurrent = true;
	const saved = await captureFailure(currentTest.fullName);
	if (saved.length > 0) console.error(`[linux-check] 落ちた時点の記録: ${saved.join(', ')}`);
}

/** 落ちた時点の画面と、窓の一覧とフォーカスを `FAILURE_DIR` に置き、置いた先を返す。どれも投げない */
async function captureFailure(name) {
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
		await execFileAsync('grim', [`${base}.png`], { timeout: 30_000 });
		saved.push(`${base}.png`);
	} catch (error) {
		console.error(`[linux-check] 画面を撮れませんでした: ${error.message}`);
	}
	try {
		const state = {
			active: await hyprctlJson('activewindow'),
			clients: await hyprctlJson('clients')
		};
		await fs.writeFile(`${base}.json`, `${JSON.stringify(state, null, '\t')}\n`);
		saved.push(`${base}.json`);
	} catch (error) {
		console.error(`[linux-check] 窓の一覧を読めませんでした: ${error.message}`);
	}
	return saved;
}
