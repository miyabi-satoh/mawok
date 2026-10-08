import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	expectDraftStaysHidden,
	expectDraftStaysVisible,
	invokeApp,
	readDraft,
	selectCopyCategory,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitDraftHidden,
	waitDraftVisible,
	waitForWindowCount,
	waitSettingsWindow
} from '../lib/app.mjs';
import {
	findVisibleMawokWindow,
	getClipboard,
	getDraftWindowHandle,
	getForegroundWindowHandle,
	killMawokRenderers,
	setClipboard
} from '../lib/os.mjs';
import { LICENSES_TITLE, SETTINGS_MIN_SIZE } from '../lib/app-conf.mjs';
import { clickTitleBar, dragBottomRightCorner, sendKeySequence, VK } from '../lib/input.mjs';
import { hasUiaElementNamed, moveWindow, near, readWindow } from '../lib/window.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import { launchPasteTarget } from '../lib/paste-target.mjs';
import { waitFor } from '../lib/wait.mjs';

// 設定ウィンドウ。開く・閉じるキーは本物のキー入力で送り、下書きが隠れる・出し直されることは
// ネイティブウィンドウで見る。最小の大きさや位置の記憶は、端のドラッグの代わりに SetWindowPos で動かして見る

const suite = createSuite();
const SENTINEL = 'e2e-sentinel-before';

async function closeSettingsWithKey(client, combo) {
	await sendKeySequence([combo]);
	await waitForWindowCount(client, 1);
}

test.describe('設定ウィンドウ', () => {
	let testConfig;
	let client;
	let pasteTarget;
	let draftHandle;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			hideTextWindowOnBlur: true,
			textWindowAlwaysOnTop: true,
			replacements: [],
			punctuationStyle: 'keep'
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
		[draftHandle] = await client.getWindowHandles();
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

	for (const { key, combo } of [
		{ key: 'Esc', combo: [VK.ESCAPE] },
		{ key: 'Ctrl+W', combo: [VK.CONTROL, VK.W] }
	]) {
		test(`書きかけの下書きで Ctrl+, を押すと設定が開いて下書きが隠れ、クリップボードは変わらず、${key} で閉じると書きかけのまま出し直される`, async () => {
			await setClipboard(SENTINEL);
			const text = `e2e settings ${Date.now()}`;
			await showDraftAndWaitVisible();
			await typeIntoDraft(client, text);

			await sendKeySequence([[VK.CONTROL, VK.COMMA]]);
			await waitDraftHidden('設定を開いたときの下書きの非表示');
			await waitSettingsWindow(client, draftHandle);
			assert.equal(await getClipboard(), SENTINEL, '設定を開いてもコピーはしないはず');

			await closeSettingsWithKey(client, combo);
			await waitDraftVisible(`${key} で閉じた後の下書きの出し直し`);
			const draftHwnd = await getDraftWindowHandle();
			await waitFor(getForegroundWindowHandle, (handle) => handle === draftHwnd, {
				label: '出し直した下書きが前面になる'
			});
			await waitFor(
				() => readDraft(client),
				(draft) => draft.value === text && draft.focused,
				{ label: '書きかけが残り、入力欄にカーソルがある' }
			);
		});
	}

	test('下書きを隠した状態でトレイと同じ入口から設定を開くと、閉じても下書きは出ず、ほかのアプリにフォーカスが戻る', async () => {
		// トレイの「設定…」と同じ関数 (lib.rs の open_settings) を、コマンドから呼ぶ
		await invokeApp(client, 'open_settings_window');
		await waitSettingsWindow(client, draftHandle);

		await closeSettingsWithKey(client, [VK.ESCAPE]);
		await expectDraftStaysHidden('設定を閉じた後');
		await pasteTarget.waitForeground('設定を閉じた後のフォーカス');
	});

	/** 下書きを出して Ctrl+, で設定を開き、設定を開いたままホットキーで下書きを出し直す */
	async function openSettingsThenShowDraftWithHotkey() {
		await showDraftAndWaitVisible();
		await sendKeySequence([[VK.CONTROL, VK.COMMA]]);
		await waitDraftHidden('設定を開いたときの下書きの非表示');
		const { settingsHwnd } = await waitSettingsWindow(client, draftHandle);
		await showDraftAndWaitVisible('設定を開いたままホットキーで出す');
		return settingsHwnd;
	}

	/** 設定ウィンドウをタイトルバーのクリックで前面にしてから Esc で閉じる (設定へ移るのは、ほかのアプリへ移ったとは見なさない) */
	async function focusAndCloseSettings(settingsHwnd) {
		// 中身を押すと設定のボタンに当たりうるので、タイトルバーを押す
		await clickTitleBar(settingsHwnd);
		await waitFor(getForegroundWindowHandle, (handle) => handle === settingsHwnd, {
			label: '設定ウィンドウをクリックして前面にする'
		});
		await closeSettingsWithKey(client, [VK.ESCAPE]);
	}

	test('設定を開いた後にホットキーで下書きを出すと、設定を閉じても下書きは出たまま前面に来る', async () => {
		const settingsHwnd = await openSettingsThenShowDraftWithHotkey();
		const draftHwnd = await getDraftWindowHandle();
		await focusAndCloseSettings(settingsHwnd);
		await expectDraftStaysVisible('設定を閉じた後');
		await waitFor(getForegroundWindowHandle, (handle) => handle === draftHwnd, {
			label: '設定を閉じた後に下書きが前面に来る'
		});
	});

	test('設定を開いたままホットキーで出した下書きで設定キーを押すと、設定が閉じて入力欄に戻る', async () => {
		await openSettingsThenShowDraftWithHotkey();
		await sendKeySequence([[VK.CONTROL, VK.COMMA]]);
		await waitForWindowCount(client, 1);
		await expectDraftStaysVisible('設定キーで閉じた後');
		await waitFor(
			() => readDraft(client),
			(draft) => draft.focused,
			{ label: '設定キーで閉じた後に入力欄へフォーカスが戻る' }
		);
	});

	test('設定を開いた後にホットキーで出した下書きを隠すと、設定を閉じても下書きは出し直さない', async () => {
		// ホットキーで出した時点で、設定のために隠したという記録は消える。それが消えずに残っていると、
		// ユーザーが自分で隠した下書きを、設定を閉じたときに出し直してしまう
		const settingsHwnd = await openSettingsThenShowDraftWithHotkey();
		await sendKeySequence([[VK.ESCAPE]]);
		await waitDraftHidden('ホットキーで出した下書きを Esc で隠す');
		await focusAndCloseSettings(settingsHwnd);
		await expectDraftStaysHidden('設定を閉じた後');
	});

	test(`設定ウィンドウは最小 ${SETTINGS_MIN_SIZE.width}×${SETTINGS_MIN_SIZE.height} より小さくならない`, async () => {
		await invokeApp(client, 'open_settings_window');
		const { settingsHwnd } = await waitSettingsWindow(client, draftHandle);
		const before = await readWindow(settingsHwnd);

		// 利用者がするのと同じく、右下の角をドラッグして、最小よりずっと小さくしようとする
		// (SetWindowPos は最小の大きさを通り抜けるので使わない)
		await dragBottomRightCorner(settingsHwnd, -before.window.width, -before.window.height);
		// 小さくする操作が効いて最小で止まったことを、中身の大きさが最小とほぼ同じになったことで見る
		// (最小より大きいままなら、小さくする操作そのものが効いていない)
		const after = await readWindow(settingsHwnd);
		near(after.client.width / after.scale, SETTINGS_MIN_SIZE.width, '小さくした後の中身の幅');
		near(after.client.height / after.scale, SETTINGS_MIN_SIZE.height, '小さくした後の中身の高さ');
	});

	test('置き換え辞書の行を増やしてもウィンドウは伸びず、右の区画がスクロールする', async () => {
		await invokeApp(client, 'open_settings_window');
		const { settingsHandle, settingsHwnd } = await waitSettingsWindow(client, draftHandle);
		await client.switchToWindow(settingsHandle);
		const addButton = await selectCopyCategory(client);
		const before = await readWindow(settingsHwnd);

		// 空の行が残っていると「追加」は新しく足さないので、足すたびに1文字書く (足した行の欄にフォーカスが移る)
		for (let i = 0; i < 15; i++) {
			await addButton.click();
			await client.keys(['r']);
		}
		await waitFor(
			() => client.$$('input[aria-label="置き換える前の文字列"]').length,
			(count) => count === 15,
			{ label: '置き換え辞書の行が 15 行になる' }
		);
		const after = await readWindow(settingsHwnd);
		assert.deepEqual(after.window, before.window, 'ウィンドウの位置と大きさは変わらないはず');
		const scroll = await client.execute(() => {
			const panel = [...document.querySelectorAll('div')].find(
				(element) => getComputedStyle(element).overflowY === 'auto'
			);
			return {
				panelScrolls: panel !== undefined && panel.scrollHeight > panel.clientHeight,
				pageScrolls: document.documentElement.scrollHeight > window.innerHeight
			};
		});
		assert.equal(scroll.panelScrolls, true, '右の区画はスクロールするはず');
		assert.equal(scroll.pageScrolls, false, 'ページ全体は伸びないはず');
	});

	test('動かした位置と変えた大きさは、閉じて開き直しても残る', async () => {
		await invokeApp(client, 'open_settings_window');
		let { settingsHwnd } = await waitSettingsWindow(client, draftHandle);
		const before = await readWindow(settingsHwnd);
		// 主画面の中に収まる位置にする (外にはみ出すと、出すときに画面の中へ動かされる)
		const target = {
			x: Math.round(80 * before.scale),
			y: Math.round(60 * before.scale),
			width: before.window.width + Math.round(60 * before.scale),
			height: before.window.height + Math.round(40 * before.scale)
		};
		await moveWindow(settingsHwnd, target);

		await closeSettingsWithKey(client, [VK.ESCAPE]);
		await invokeApp(client, 'open_settings_window');
		({ settingsHwnd } = await waitSettingsWindow(client, draftHandle));
		const reopened = await readWindow(settingsHwnd);
		for (const key of ['x', 'y', 'width', 'height']) {
			near(reopened.window[key], target[key], `開き直した設定ウィンドウの ${key}`);
		}
	});

	test('表示言語を切り替えると、その場で文言が変わる', async () => {
		await invokeApp(client, 'open_settings_window');
		const { settingsHandle } = await waitSettingsWindow(client, draftHandle);
		await client.switchToWindow(settingsHandle);
		const tabLabels = () =>
			client.execute(() =>
				[...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent.trim())
			);
		try {
			await client.$('button=English').click();
			await waitFor(tabLabels, (labels) => labels.includes('General'), {
				label: 'English に切り替えた後の分類の名前'
			});
			await client.$('button=日本語').click();
			await waitFor(tabLabels, (labels) => labels.includes('一般'), {
				label: '日本語に戻した後の分類の名前'
			});
		} finally {
			await invokeApp(client, 'set_language', { language: 'ja' });
		}
	});

	test('設定とライセンスのウィンドウの描画プロセスが落ちても、読み込み直して描き直す', async () => {
		await invokeApp(client, 'open_settings_window');
		const { settingsHandle, settingsHwnd } = await waitSettingsWindow(client, draftHandle);
		await client.switchToWindow(settingsHandle);
		await invokeApp(client, 'open_licenses_window');
		await waitForWindowCount(client, 3);
		const licensesHwnd = await waitFor(
			() => findVisibleMawokWindow(LICENSES_TITLE),
			(hwnd) => hwnd !== null,
			{ label: '第三者のソフトウェアのウィンドウ' }
		);
		// 描かれたかの目印。設定は分類のタブ、ライセンスは節の見出し (窓のタイトルと同じ文言は避ける)
		const marks = [
			{ label: '設定', hwnd: settingsHwnd, name: '一般' },
			{ label: '第三者のソフトウェア', hwnd: licensesHwnd, name: 'アプリ本体' }
		];
		for (const { label, hwnd, name } of marks) {
			await waitFor(
				() => hasUiaElementNamed(hwnd, name),
				(found) => found,
				{ label: `落とす前の${label}のウィンドウの「${name}」` }
			);
		}

		assert.ok((await killMawokRenderers()) > 0, '描画プロセスを落とせたはず');
		// 落ちた直後に読むと、落ちる前の画面の中身が残っていて、立て直していなくても見つかることがある。
		// 立て直さなければ、この間に WebView2 のエラーの画面 (RESULT_CODE_KILLED) に替わる
		await new Promise((resolve) => setTimeout(resolve, 2000));

		// 一度落ちた窓は、読み込み直した後も WebDriver からは "tab crashed" のままで読めないので、UI Automation で見る
		for (const { label, hwnd, name } of marks) {
			await waitFor(
				() => hasUiaElementNamed(hwnd, name),
				(found) => found,
				{ label: `落ちた後の${label}のウィンドウの描き直し`, timeout: 15_000, interval: 500 }
			);
		}
	});
});
