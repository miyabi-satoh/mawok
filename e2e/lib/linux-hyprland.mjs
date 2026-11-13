// linux.mjs の、Hyprland での窓・フォーカス・ホットキーの割り当ての扱い。窓とフォーカスは hyprctl で読み、
// ホットキーは Hyprland の割り当てを替えて確かめる道へ向ける (Hyprland の portal は、登録を受けても自分ではキーを付けない)
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PROFILE, PROFILE_ENV, PROFILE_IDENTIFIER } from './app-conf.mjs';
import { waitFor } from './wait.mjs';

const execFileAsync = promisify(execFile);

// ydotoold が作る仮想の装置。keyd が掴むと、送ったキーが Hyprland に届かない
const YDOTOOL_DEVICE_ID = '2333:6666';
/** ホットキー (Aero の Hyprland の割り当てと同じ)。どちらの道も、このキーの割り当てを替えて押す */
const HOTKEY = 'CTRL + SHIFT + SPACE';
const OTHER_APP = 'mawok-e2e-other';

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

async function cursorPosition() {
	const [x, y] = (await hyprctl(['cursorpos'])).trim().split(/,\s*/).map(Number);
	return { x, y };
}

/** Hyprland が動いていれば、その環境変数を足して true を返す */
export async function detect(runtime) {
	if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) {
		const instances = await fs.readdir(path.join(runtime, 'hypr')).catch(() => []);
		if (instances.length === 0) return false;
		if (instances.length > 1) {
			throw new Error(
				`Hyprland が ${instances.length} つ動いています。HYPRLAND_INSTANCE_SIGNATURE で選んでください`
			);
		}
		process.env.HYPRLAND_INSTANCE_SIGNATURE = instances[0];
	}
	if (!process.env.WAYLAND_DISPLAY) {
		const socket = (await hyprctlJson('instances')).find(
			(i) => i.instance === process.env.HYPRLAND_INSTANCE_SIGNATURE
		)?.wl_socket;
		if (!socket) throw new Error('Hyprland の Wayland のソケットが分かりません');
		process.env.WAYLAND_DISPLAY = socket;
	}
	return true;
}

export const name = 'hyprland';
export const tools = [['grim', 'sudo pacman -S grim']];

/** keyd が ydotool の装置を掴まないこと、ポインターがこの機の画面にあること */
export async function preflight({ ydotool, sleep }) {
	await assertKeydIgnoresYdotool();
	// Deskflow のサーバーでポインターがほかの機に移っていると、ydotool のキーもポインターもそちらへ送られる。
	// ydotool でポインターを少し動かし、Hyprland のポインターが動くかで見る
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

async function assertKeydIgnoresYdotool() {
	const active = await execFileAsync('systemctl', ['is-active', 'keyd']).then(
		() => true,
		() => false
	);
	if (!active) return;
	const configs = await fs.readdir('/etc/keyd').catch(() => []);
	for (const file of configs.filter((n) => n.endsWith('.conf'))) {
		const text = await fs.readFile(path.join('/etc/keyd', file), 'utf8').catch(() => '');
		const ids = text.split(/^\[/m).find((section) => section.startsWith('ids]')) ?? '';
		const lines = ids.split('\n').map((line) => line.trim());
		if (lines.includes('*') && !lines.includes(`-${YDOTOOL_DEVICE_ID}`)) {
			throw new Error(
				`keyd が ydotool の装置を掴みます。/etc/keyd/${file} の [ids] に -${YDOTOOL_DEVICE_ID} を足し、` +
					'sudo systemctl restart keyd してください (keyd reload は落ちることがある)'
			);
		}
	}
}

/** 見えている窓。`app` は Hyprland のクラス */
export async function windows() {
	return (await hyprctlJson('clients'))
		.filter((c) => !c.hidden)
		.map((c) => ({ app: c.class, title: c.title }));
}

export async function activeWindow() {
	const active = await hyprctlJson('activewindow');
	return active?.address ? { app: active.class, title: active.title } : null;
}

/** portal に登録できたホットキーが、Hyprland の global shortcuts にあるか */
export async function portalShortcutRegistered() {
	const out = await hyprctl(['globalshortcuts']);
	return out
		.split('\n')
		.some((line) => line.split(' -> ')[0].trim() === `${PROFILE_IDENTIFIER}:toggle`);
}

/** Hyprland の portal は確かめの画面を出さない */
export async function approvePortalShortcut() {
	return false;
}

/**
 * ホットキーを、確かめる道に向ける。`portal` は portal の登録へ (`global`)、`toggle` は `mawok --toggle` へ。
 * 押すキーの組み合わせ (linux.mjs の KEY の名前) を返す
 */
export async function bindHotkey(mode, appPath) {
	await unbindHotkey();
	const action =
		mode === 'portal'
			? `hl.dsp.global("${PROFILE_IDENTIFIER}:toggle")`
			: `hl.dsp.exec_cmd("env ${PROFILE_ENV}=${PROFILE} ${appPath} --toggle")`;
	await hyprEval(`hl.bind("${HOTKEY}", ${action})`);
	return ['ctrl', 'shift', 'space'];
}

export async function unbindHotkey() {
	await hyprEval(`hl.unbind("${HOTKEY}")`);
}

/** 控えるもの。Hyprland の割り当ては設定を読み直せば戻るので、控えは要らない */
export async function hold() {
	return null;
}

/** 割り当てを利用者の設定に戻す */
export async function restore() {
	await hyprctl(['reload']);
}

/** 常用の Mawok を、ログインしたときと同じく uwsm の下で起動する */
export function launchRegular(appPath) {
	spawn('setsid', ['-f', 'uwsm-app', '--', appPath], { stdio: 'ignore', detached: true }).unref();
}

/** 下書きを隠した後にフォーカスが戻る先として、端末を1つ開いてフォーカスを渡す */
export async function launchOtherWindow() {
	const child = spawn('foot', ['--app-id', OTHER_APP, 'sleep', '600'], {
		stdio: 'ignore',
		detached: true
	});
	child.unref();
	const win = await waitFor(
		async () => (await hyprctlJson('clients')).find((c) => c.class === OTHER_APP) ?? null,
		Boolean,
		{ timeout: 10_000, label: 'ほかの窓が開く' }
	);
	const focus = () => hyprEval(`hl.dispatch(hl.dsp.focus({ window = "address:${win.address}" }))`);
	await focus().catch(() => {});
	return {
		app: OTHER_APP,
		focus,
		async close() {
			try {
				process.kill(child.pid);
			} catch {
				// 閉じていてもよい
			}
		}
	};
}

/** 落ちた時点の画面を撮る */
export async function screenshot(file) {
	await execFileAsync('grim', [file], { timeout: 30_000 });
}

/** 落ちた時点の、窓の一覧とフォーカス */
export async function state() {
	return { active: await hyprctlJson('activewindow'), clients: await hyprctlJson('clients') };
}
