import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createSuite } from '../lib/setup.mjs';
import {
	APP_PATH,
	hideDraftWithoutCopy,
	invokeApp,
	setJapanese,
	showDraft,
	showDraftAndWaitVisible,
	waitDraftHidden,
	waitDraftVisible,
	waitForWindowCount
} from '../lib/app.mjs';
import {
	countMawokProcesses,
	findVisibleMawokWindow,
	getDraftWindowHandle,
	getForegroundWindowHandle
} from '../lib/os.mjs';
import {
	appearsInAltTab,
	isWindowAbove,
	listTaskbarButtonNames,
	moveWindow,
	near,
	readWindow
} from '../lib/window.mjs';
import { dragBottomRightCorner } from '../lib/input.mjs';
import { countTrayIcons } from '../lib/tray.mjs';
import { beginTestConfig, WINDOW_STATE_PATH } from '../lib/config.mjs';
import { DRAFT_DEFAULT_SIZE, DRAFT_MIN_SIZE, SETTINGS_TITLE } from '../lib/app-conf.mjs';
import { launchPasteTarget } from '../lib/paste-target.mjs';
import { waitFor } from '../lib/wait.mjs';

// 下書きのウィンドウ (多重起動とトレイのアイコンの数、位置と大きさ、Windows での見え方)。
// 位置と大きさは、ドラッグの代わりに SetWindowPos で変える。ただし最小の大きさだけは、
// SetWindowPos が最小を通り抜けて小さくできてしまうので、右下の角を本物のドラッグで縮めて見る。
// 最前面やタスクバーに出るかは、ウィンドウのスタイルと重なり順、タスクバーのボタン (UI Automation) で見る。
// Alt+Tab に出るかは、ウィンドウのスタイルとオーナーで見る (window.mjs の appearsInAltTab)。
// 位置と大きさの記録 (.window-state.json) は、config.toml と一緒に控えて戻す (config.mjs)

const suite = createSuite();

/** 主画面の中に収まる位置へ、今より少し大きくして動かす先 (外にはみ出すと、出すときに画面の中へ動かされる) */
function targetRect(current) {
	return {
		x: Math.round(100 * current.scale),
		y: Math.round(90 * current.scale),
		width: current.window.width + Math.round(80 * current.scale),
		height: current.window.height + Math.round(60 * current.scale)
	};
}

function expectRect(actual, target, label) {
	for (const key of ['x', 'y', 'width', 'height'])
		near(actual[key], target[key], `${label}の ${key}`);
}

test.describe('下書きのウィンドウ', () => {
	let testConfig;
	let client;
	let pasteTarget;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			textWindowAlwaysOnTop: true,
			// 下書きを出したままほかのウィンドウをクリックして、重なり順を見るので隠さない
			hideTextWindowOnBlur: false
		});
	});
	test.after(async () => {
		try {
			await testConfig?.restore();
		} finally {
			await suite.after();
		}
	});

	test.beforeEach(async () => {
		client = await suite.newClient();
		await setJapanese(client);
		pasteTarget = await launchPasteTarget();
		await pasteTarget.activate();
	});
	test.afterEach(async () => {
		try {
			await pasteTarget?.close();
		} finally {
			await suite.closeClient(client);
		}
	});

	test('起動中にもう一度起動すると、2つ目は残らず、もとのアプリの下書きが出て、トレイのアイコンも増えない', async () => {
		assert.equal(await countMawokProcesses(), 1);
		// アイコンは起動の少し後に出る。前に強制終了されたアプリのアイコンが消えずに残っていることもあるので、
		// 1つかどうかではなく、2つ目を起動する前と比べる
		const iconsBefore = await waitFor(countTrayIcons, (count) => count >= 1, {
			label: 'トレイのアイコン'
		});
		const second = spawn(APP_PATH, [], { stdio: 'ignore' });
		const exitCode = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				second.kill();
				reject(new Error('2つ目の Mawok が終わりませんでした'));
			}, 15_000);
			second.once('error', reject);
			second.once('exit', (code) => {
				clearTimeout(timer);
				resolve(code);
			});
		});
		assert.equal(exitCode, 0, '2つ目はすぐ終わるはず');
		await waitDraftVisible('もとのアプリの下書きが出る');
		assert.equal(await countMawokProcesses(), 1, 'プロセスは増えないはず');
		assert.equal(await countTrayIcons(), iconsBefore, 'トレイのアイコンは増えないはず');
	});

	test('動かして大きさを変えた下書きは、隠して出し直してもその位置と大きさで出る', async () => {
		await showDraftAndWaitVisible();
		const hwnd = await getDraftWindowHandle();
		const target = targetRect(await readWindow(hwnd));
		await moveWindow(hwnd, target);
		expectRect((await readWindow(hwnd)).window, target, '動かした直後');

		await hideDraftWithoutCopy(client);
		await waitDraftHidden('Esc 後の非表示');
		await showDraftAndWaitVisible('出し直し');
		expectRect((await readWindow(await getDraftWindowHandle())).window, target, '出し直した下書き');
	});

	test('動かして大きさを変えた下書きは、アプリを起動し直してもその位置と大きさで出る', async () => {
		await showDraftAndWaitVisible();
		const hwnd = await getDraftWindowHandle();
		const target = targetRect(await readWindow(hwnd));
		await moveWindow(hwnd, target);
		// 隠すときに位置と大きさを記録する
		await hideDraftWithoutCopy(client);
		await waitDraftHidden('Esc 後の非表示');

		await suite.closeClient(client);
		client = await suite.newClient();
		await pasteTarget.activate();
		await showDraftAndWaitVisible('起動し直した後の表示');
		expectRect(
			(await readWindow(await getDraftWindowHandle())).window,
			target,
			'起動し直した後の下書き'
		);
	});

	test(`下書きウィンドウは最小 ${DRAFT_MIN_SIZE.width}×${DRAFT_MIN_SIZE.height} より小さくならない`, async () => {
		await showDraftAndWaitVisible();
		const hwnd = await getDraftWindowHandle();
		const before = await readWindow(hwnd);

		// 利用者がするのと同じく、右下の角をドラッグして、最小よりずっと小さくしようとする
		// (SetWindowPos は最小の大きさを通り抜けるので使わない)
		await dragBottomRightCorner(hwnd, -before.window.width, -before.window.height);
		// 小さくする操作が効いて最小で止まったことを、中身の大きさが最小とほぼ同じになったことで見る
		// (最小より大きいままなら、小さくする操作そのものが効いていない)
		const after = await readWindow(hwnd);
		near(after.client.width / after.scale, DRAFT_MIN_SIZE.width, '小さくした後の中身の幅');
		near(after.client.height / after.scale, DRAFT_MIN_SIZE.height, '小さくした後の中身の高さ');
	});

	test('最小の大きさがなかったころの記録が残っていても、読まずに既定の大きさで出る', async () => {
		// window-state プラグインは、記録した大きさを最小と比べずにそのまま当てる。そこで記録の名前を
		// "main" から "main-min-size" に変えてある (lib.rs の window_state_key)。古い "main" の記録が
		// 残っていても読まれないので、既定の大きさで出る
		await suite.closeClient(client);
		const old = {
			width: 162,
			height: 92,
			x: 120,
			y: 120,
			prev_x: 120,
			prev_y: 120,
			maximized: false,
			visible: true,
			decorated: true,
			fullscreen: false
		};
		await writeFile(WINDOW_STATE_PATH, JSON.stringify({ main: old }, null, 2), 'utf8');

		client = await suite.newClient();
		await showDraftAndWaitVisible('古い記録があるときの表示');
		const draft = await readWindow(await getDraftWindowHandle());
		// 最小に収めて当てたのではなく、古い記録を読まずに既定の大きさで出たことを見る
		near(
			draft.client.width / draft.scale,
			DRAFT_DEFAULT_SIZE.width,
			'古い記録があるときの中身の幅'
		);
		near(
			draft.client.height / draft.scale,
			DRAFT_DEFAULT_SIZE.height,
			'古い記録があるときの中身の高さ'
		);
	});

	test('下書きウィンドウには最小化・最大化のボタンがない', async () => {
		await showDraftAndWaitVisible();
		const draft = await readWindow(await getDraftWindowHandle());
		assert.equal(draft.minimizeBox, false, '最小化のボタンはないはず');
		assert.equal(draft.maximizeBox, false, '最大化のボタンはないはず');
	});

	test('下書きは常に最前面にあり、ほかのウィンドウをクリックしても前に出たまま', async () => {
		await showDraftAndWaitVisible();
		const hwnd = await getDraftWindowHandle();
		assert.equal((await readWindow(hwnd)).topmost, true);
		await pasteTarget.activate();
		assert.equal(await isWindowAbove(hwnd, pasteTarget.hwnd), true, '下書きが上にあるはず');
	});

	test('「下書きを常に最前面に表示」をオフにすると、ほかのウィンドウをクリックしたときに後ろへ回り、ホットキーで前面に出る', async () => {
		await invokeApp(client, 'set_draft_always_on_top', { enabled: false });
		try {
			await showDraftAndWaitVisible();
			const hwnd = await getDraftWindowHandle();
			assert.equal((await readWindow(hwnd)).topmost, false, '最前面は外れているはず');

			await pasteTarget.activate();
			assert.equal(
				await isWindowAbove(pasteTarget.hwnd, hwnd),
				true,
				'クリックしたウィンドウが上に来るはず'
			);

			await showDraft();
			await waitFor(getForegroundWindowHandle, (handle) => handle === hwnd, {
				label: 'ホットキーで下書きが前面に出る'
			});
			assert.equal(await isWindowAbove(hwnd, pasteTarget.hwnd), true, '下書きが上に戻るはず');
		} finally {
			// 設定ファイルに書かれ、このファイルのほかのテスト (起動し直す) に残るので戻す
			await invokeApp(client, 'set_draft_always_on_top', { enabled: true });
		}
	});

	test('設定ウィンドウはタスクバーと Alt+Tab に出る', async () => {
		// 「設定」などの名前のボタンは、ほかのアプリのピン留めでもありうるので、設定を開く前との差で見る。
		// 通知領域には名前が刻々と変わるボタン (CPU 使用率など) もあるので、差は Mawok と設定の名前のものに絞る
		const before = await listTaskbarButtonNames();
		const added = async () => {
			const names = await listTaskbarButtonNames();
			return names.filter((name) => !before.includes(name) && /Mawok|設定/.test(name));
		};

		const [draftHandle] = await client.getWindowHandles();
		await invokeApp(client, 'open_settings_window');
		await waitForWindowCount(client, 2);
		const settingsHwnd = await waitFor(
			() => findVisibleMawokWindow(SETTINGS_TITLE),
			(found) => found !== null,
			{ label: '設定ウィンドウの表示' }
		);
		const settingsWindow = await readWindow(settingsHwnd);
		assert.equal(settingsWindow.toolWindow, false, 'ツールウィンドウではないはず');
		assert.ok(
			appearsInAltTab(settingsWindow),
			`Alt+Tab に出る形のはず: ${JSON.stringify(settingsWindow)}`
		);
		const buttons = await waitFor(added, (names) => names.length > 0, {
			label: '設定を開いた後に増えたタスクバーのボタン'
		});
		assert.ok(buttons.length > 0, `増えたボタン: ${JSON.stringify(buttons)}`);

		await client.switchToWindow(draftHandle);
		await invokeApp(client, 'close_settings_window');
		await waitForWindowCount(client, 1);
		await waitFor(added, (names) => names.length === 0, {
			label: '設定を閉じた後のタスクバー (開く前に戻る)'
		});
	});
});
