import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	closeApp,
	ensureSessionEnv,
	invoke,
	launchApp,
	LOG_PATH,
	mawokPids,
	startDriver,
	waitLog
} from '../lib/linux.mjs';
import { markLog } from '../lib/files.mjs';
import { waitFor } from '../lib/wait.mjs';

const execFileAsync = promisify(execFile);

// Linux のデスクトップに合わせた作りのうち、ホットキーと描画プロセスを見る。
// - Wayland ではホットキーをデスクトップが割り当てる (lib.rs の hotkey_by_desktop)。Hyprland の portal はキーを付けないので、
//   設定には Mawok でキーを選ぶ欄の代わりに、デスクトップのキー設定から `mawok --toggle` を呼ぶ案内が出る
// - WebKitGTK の描画プロセスが落ちたら、読み込み直して画面を戻す (diagnostics.rs の watch_webview_process)

/** Mawok の子の、WebKitGTK の描画プロセス */
async function webProcesses() {
	const [pid] = await mawokPids();
	try {
		// プロセスの名前 (comm) は 15 文字で切れるので、コマンドの行で探す
		const { stdout } = await execFileAsync('pgrep', ['-P', String(pid), '-f', 'WebKitWebProcess']);
		return stdout.trim().split('\n').map(Number);
	} catch {
		return [];
	}
}

test.describe('Linux: デスクトップ', () => {
	let driver;
	let app;

	test.before(async () => {
		await ensureSessionEnv();
		driver = await startDriver();
		app = await launchApp(driver);
	});

	test.after(async () => {
		await closeApp(app?.client);
		await driver?.stop();
	});

	test('ホットキーはデスクトップが割り当て、Hyprland の portal はキーを付けない (設定は mawok --toggle の案内になる)', async () => {
		const view = await invoke(app.client, 'get_settings');
		assert.equal(view.platform, 'linux');
		assert.equal(view.hotkeyByDesktop, true);
		// desktopHotkey が無いと、設定の「キー操作」は mawok --toggle の案内を出す (settings/+page.svelte)。
		// 設定の窓の中は WebDriver から読めない (WebKitWebDriver に出るのは最初の窓だけ) ので、画面が受け取る値で見る
		assert.equal(view.desktopHotkey, null, 'Hyprland の portal はキーを付けない');
	});

	// 描画プロセスを落とすと WebDriver のセッションも切れるので、落とすテストは最後に置く
	test('描画プロセスが落ちると、読み込み直して下書きの画面が戻る', async () => {
		// 描画プロセスは窓ごとに分かれることがあるので、下書きの窓のものと決め打ちせず全部落とす
		const killed = await waitFor(webProcesses, (pids) => pids.length > 0, {
			label: '描画プロセス'
		});
		const mark = markLog(LOG_PATH);
		await execFileAsync('kill', ['-KILL', ...killed.map(String)]);
		await waitLog(mark, 'reloaded the webview in window main', '落ちた描画プロセスの読み込み直し');
		// WebDriver のセッションは落ちたプロセスと一緒に切れるので、読み込み直した画面が知らせる page_ready をログで見る
		await waitLog(mark, 'page ready (main ', '読み込み直した下書きの画面の page_ready');
		const now = await webProcesses();
		assert.ok(
			now.length > 0 && now.every((pid) => !killed.includes(pid)),
			'新しい描画プロセスで動いている'
		);
	});
});
