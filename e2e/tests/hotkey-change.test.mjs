import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	DEFAULT_HOTKEY,
	expectDraftStaysHidden,
	invokeApp,
	OTHER_HOTKEY,
	sendHotkeyAsKeyInput,
	setJapanese,
	waitDraftHidden,
	waitDraftVisible,
	waitForWindowCount,
	waitSettingsWindow
} from '../lib/app.mjs';
import { SETTINGS_TITLE } from '../lib/app-conf.mjs';
import { findVisibleMawokWindow, getForegroundWindowHandle } from '../lib/os.mjs';
import { clickTitleBar, sendKeySequence, VK } from '../lib/input.mjs';
import { beginTestConfig, tryReadConfig } from '../lib/config.mjs';
import { launchPasteTarget } from '../lib/paste-target.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';

// ホットキーの変更。記録は本物のキー入力で送る (記録は画面側の keydown で受け、
// その間は Rust 側で今のホットキーを止めているので、OS から見たキー入力でないと確かめられない)。
// ほかのアプリや OS が先に取っているキー (5. の 3.) は環境しだいなので見ない

const suite = createSuite();

test.describe('ホットキーの変更', () => {
	let testConfig;
	let client;
	let pasteTarget;
	let draftHandle;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({ hideTextWindowOnBlur: true });
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

	/** 設定を開き、WebDriver を設定ウィンドウに切り替えて、「変更」を押して記録を始める */
	async function startRecording() {
		await client.switchToWindow(draftHandle);
		await invokeApp(client, 'open_settings_window');
		const { settingsHandle, settingsHwnd } = await waitSettingsWindow(client, draftHandle);
		await client.switchToWindow(settingsHandle);
		// ホットキーは「キー操作」の分類にある。ほかの分類の項目は hidden で隠れている
		await client.$('button[role="tab"]*=キー操作').click();
		await client.$('button[aria-label^="ホットキーを変更"]').click();
		await client.$('[role="status"]*=キーを押してください').waitForDisplayed({ timeout: 5000 });
		return settingsHwnd;
	}

	/** 記録を終えた設定ウィンドウを Esc で閉じ、WebDriver を下書きに戻す */
	async function closeSettings() {
		await sendKeySequence([[VK.ESCAPE]]);
		await waitForWindowCount(client, 1);
		await client.switchToWindow(draftHandle);
	}

	test('記録中の Esc は記録をやめるだけで、設定ウィンドウは閉じない', async () => {
		const settingsHwnd = await startRecording();
		await sendKeySequence([[VK.ESCAPE]]);
		await client.$('button[aria-label^="ホットキーを変更"]').waitForDisplayed({ timeout: 5000 });
		await expectStays(() => findVisibleMawokWindow(SETTINGS_TITLE), settingsHwnd, {
			label: '記録中の Esc の後: 設定ウィンドウ',
			duration: 1000
		});
		assert.equal((await client.getWindowHandles()).length, 2, '設定ウィンドウは閉じないはず');
		const config = await tryReadConfig();
		assert.equal(config?.hotkey, DEFAULT_HOTKEY, 'ホットキーは変わらないはず');
	});

	test('別の組み合わせを登録するとそのキーで下書きが出て元のキーでは出ず、既定の組み合わせに戻せる', async () => {
		try {
			await startRecording();
			await sendKeySequence([[VK.CONTROL, VK.SHIFT, VK.J]]);
			await waitFor(tryReadConfig, (config) => config?.hotkey === OTHER_HOTKEY, {
				label: 'config.toml のホットキーが変わる'
			});
			// 登録したその場で効くことを、設定を閉じる前に見る。設定を閉じるときには設定のホットキーを
			// 登録し直すので、閉じた後だけで見ると、記録で登録し損ねていても通ってしまう
			await sendKeySequence([[VK.CONTROL, VK.SHIFT, VK.J]]);
			await waitDraftVisible('設定を開いたまま、登録した組み合わせで下書きが出る');
			await client.switchToWindow(draftHandle);
			await sendKeySequence([[VK.ESCAPE]]);
			await waitDraftHidden('出た下書きを Esc で隠す');
			await client.switchToWindow((await client.getWindowHandles()).find((h) => h !== draftHandle));
			const settingsHwnd = await findVisibleMawokWindow(SETTINGS_TITLE);
			await clickTitleBar(settingsHwnd);
			await waitFor(getForegroundWindowHandle, (handle) => handle === settingsHwnd, {
				label: '設定ウィンドウを前面に戻す'
			});
			await closeSettings();

			await sendHotkeyAsKeyInput();
			await expectDraftStaysHidden('元のホットキーを押した後', 1500);
			await sendKeySequence([[VK.CONTROL, VK.SHIFT, VK.J]]);
			await waitDraftVisible('登録した組み合わせで下書きが出る');
			await sendKeySequence([[VK.ESCAPE]]);
			await waitDraftHidden('Esc で下書きを隠す');

			// 既定の組み合わせを記録し直して戻す
			await startRecording();
			await sendHotkeyAsKeyInput();
			await waitFor(tryReadConfig, (config) => config?.hotkey === DEFAULT_HOTKEY, {
				label: 'config.toml のホットキーが既定に戻る'
			});
			await closeSettings();
			await sendHotkeyAsKeyInput();
			await waitDraftVisible('既定の組み合わせで下書きが出る');
		} finally {
			await client.switchToWindow(draftHandle).catch(() => {});
			await invokeApp(client, 'set_hotkey', { accelerator: DEFAULT_HOTKEY }).catch(() => {});
		}
	});
});
