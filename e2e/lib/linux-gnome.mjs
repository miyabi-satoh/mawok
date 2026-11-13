// linux.mjs の、GNOME (Wayland) での窓・フォーカス・ホットキーの割り当ての扱い。
// GNOME には hyprctl のような口が無く、GNOME Shell の Eval も閉じているので、窓とフォーカスはアクセシビリティ (AT-SPI。atspi.py) で読む。
// portal のホットキーは、GNOME 48 以降が確かめの画面を出して自分でキーを付ける。`mawok --toggle` は、GNOME の
// キーボードのカスタムショートカット (gsettings) に割り当てて確かめる
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { PROFILE, PROFILE_ENV } from './app-conf.mjs';
import { waitFor } from './wait.mjs';

const execFileAsync = promisify(execFile);

const ATSPI = path.join(import.meta.dirname, 'atspi.py');
const OTHER_APP = 'gnome-text-editor';
const MEDIA_KEYS = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_PATH = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/mawok-e2e/';
const CUSTOM_SCHEMA = `${MEDIA_KEYS}.custom-keybinding:${CUSTOM_PATH}`;
// `mawok --toggle` に割り当てるキー。portal に付けた Ctrl+Shift+Space とぶつからないものにする
const TOGGLE_BINDING = '<Control><Alt>m';

async function atspi(...args) {
	return (await execFileAsync('python3', [ATSPI, ...args])).stdout;
}

async function gsettings(...args) {
	return (await execFileAsync('gsettings', args)).stdout.trim();
}

/** GNOME Shell が動いていれば、そのセッションの環境変数を足して true を返す */
export async function detect(runtime) {
	const running = await execFileAsync('pgrep', [
		'-u',
		String(process.getuid()),
		'-x',
		'gnome-shell'
	]).then(
		() => true,
		() => false
	);
	if (!running) return false;
	process.env.WAYLAND_DISPLAY ??= 'wayland-0';
	process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${runtime}/bus`;
	return true;
}

export const name = 'gnome';
export const tools = [
	['python3', 'sudo apt install python3-gi gir1.2-atspi-2.0'],
	['gsettings', 'sudo apt install libglib2.0-bin']
];

export async function preflight() {
	await atspi('windows').catch((error) => {
		throw new Error(
			`アクセシビリティ (AT-SPI) で窓を読めません。sudo apt install python3-gi gir1.2-atspi-2.0: ${error.message}`
		);
	});
}

/** 見えている窓。`app` は AT-SPI のアプリ名 (隠した窓は一覧から消える) */
export async function windows() {
	return JSON.parse(await atspi('windows'))
		.filter((w) => w.showing)
		.map((w) => ({ app: w.app, title: w.title, active: w.active }));
}

export async function activeWindow() {
	const active = (await windows()).find((w) => w.active);
	return active ? { app: active.app, title: active.title } : null;
}

/** GNOME の登録の一覧は外から読めないので、確かめない (null) */
export async function portalShortcutRegistered() {
	return null;
}

/**
 * GNOME 48 以降は、アプリが初めて portal に登録を頼むと「Add Keyboard Shortcuts」の確かめの画面を出す。出ていれば「Add」を押す。
 * 押せたら true
 */
export function approvePortalShortcut() {
	return atspi('press', 'Add').then(
		() => true,
		() => false
	);
}

/**
 * ホットキーを、確かめる道に向ける。`portal` は GNOME が付けたキー (Mawok が希望した Ctrl+Shift+Space) をそのまま使い、
 * `toggle` はカスタムショートカットで `mawok --toggle` を呼ぶ。押すキーの組み合わせ (linux.mjs の KEY の名前) を返す
 */
export async function bindHotkey(mode, appPath) {
	await unbindHotkey();
	if (mode === 'portal') return ['ctrl', 'shift', 'space'];
	await gsettings('set', CUSTOM_SCHEMA, 'name', 'Mawok (e2e)');
	await gsettings(
		'set',
		CUSTOM_SCHEMA,
		'command',
		`env ${PROFILE_ENV}=${PROFILE} ${appPath} --toggle`
	);
	await gsettings('set', CUSTOM_SCHEMA, 'binding', TOGGLE_BINDING);
	const list = parseList(await gsettings('get', MEDIA_KEYS, 'custom-keybindings'));
	await gsettings('set', MEDIA_KEYS, 'custom-keybindings', formatList([...list, CUSTOM_PATH]));
	return ['ctrl', 'alt', 'm'];
}

export async function unbindHotkey() {
	const list = parseList(await gsettings('get', MEDIA_KEYS, 'custom-keybindings'));
	if (list.includes(CUSTOM_PATH)) {
		await gsettings(
			'set',
			MEDIA_KEYS,
			'custom-keybindings',
			formatList(list.filter((p) => p !== CUSTOM_PATH))
		);
	}
	for (const key of ['name', 'command', 'binding']) await gsettings('reset', CUSTOM_SCHEMA, key);
}

/** `@as []`・`['/a/', '/b/']` を配列にする */
function parseList(text) {
	return [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function formatList(list) {
	return `[${list.map((p) => `'${p}'`).join(', ')}]`;
}

/** カスタムショートカットの一覧を控える */
export async function hold() {
	return { customKeybindings: await gsettings('get', MEDIA_KEYS, 'custom-keybindings') };
}

export async function restore(held) {
	await unbindHotkey().catch(() => {});
	if (held?.customKeybindings) {
		await gsettings('set', MEDIA_KEYS, 'custom-keybindings', held.customKeybindings);
	}
}

export function launchRegular(appPath) {
	spawn('setsid', ['-f', appPath], { stdio: 'ignore', detached: true }).unref();
}

/**
 * 下書きを隠した後にフォーカスが戻る先として、テキストエディターを開く。新しい窓は前面に出る。
 * GNOME の Wayland では外から窓を前に出せないので、`focus` は前面にあることを待つだけ
 * (下書きを隠すと前面はここへ戻るので、テストの間は前面のまま)
 */
export async function launchOtherWindow() {
	const child = spawn('gnome-text-editor', ['--new-window'], { stdio: 'ignore', detached: true });
	child.unref();
	await waitFor(activeWindow, (w) => w?.app === OTHER_APP, {
		timeout: 15_000,
		label: 'ほかの窓が開いて前面に出る'
	});
	return {
		app: OTHER_APP,
		async focus() {},
		async close() {
			await execFileAsync('pkill', ['-x', 'gnome-text-edit']).catch(() => {});
		}
	};
}

/** GNOME の Wayland では、画面を撮るには portal の確かめが要るので撮らない */
export async function screenshot() {
	throw new Error('GNOME の Wayland では、確かめなしに画面を撮れません');
}

export async function state() {
	return { windows: JSON.parse(await atspi('windows')) };
}
