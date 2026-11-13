import test from 'node:test';
import assert from 'node:assert/strict';
import {
	activeWindow,
	bindHotkey,
	closeApp,
	desktopName,
	draftFocused,
	ensureSessionEnv,
	hasGlobalShortcutsPortal,
	launchApp,
	launchOtherWindow,
	portalShortcutRegistered,
	pressHotkey,
	startDriver,
	unbindHotkey,
	waitDraftVisible,
	waitLog
} from '../lib/linux.mjs';
import { waitFor } from '../lib/wait.mjs';

// Wayland ではアプリがキーを奪えないので、ホットキーは portal に登録するか (portal_hotkey.rs)、デスクトップのキー設定から
// `mawok --toggle` を呼んでもらう (toggle.rs)。どちらの道も、デスクトップの割り当てをその道に向け (linux.mjs の bindHotkey)、
// ydotool で本物のキーを押して見る

test.describe('Linux: ホットキー', () => {
	let driver;
	let app;
	let other;

	test.before(async () => {
		await ensureSessionEnv();
		driver = await startDriver();
		other = await launchOtherWindow();
		app = await launchApp(driver);
	});

	test.after(async () => {
		await closeApp(app?.client);
		await other?.close();
		await driver?.stop();
		await unbindHotkey().catch(() => {});
	});

	/** ホットキーで出して入力欄にフォーカスが入り、もう一度押すと隠れて前の窓にフォーカスが戻る */
	async function toggleTwice(label) {
		await other.focus();
		await waitFor(activeWindow, (w) => w?.app === other.app, { label: 'ほかの窓にフォーカス' });
		await pressHotkey();
		await waitDraftVisible(true, `${label}で下書きの窓が出る`);
		await waitFor(activeWindow, (w) => w?.app === 'mawok', {
			label: `${label}で出した下書きの窓にフォーカスが移る`
		});
		await waitFor(() => draftFocused(app.client), Boolean, {
			label: `${label}で出した下書きの入力欄にフォーカスが入る`
		});
		await pressHotkey();
		await waitDraftVisible(false, `${label}をもう一度押して下書きの窓が隠れる`);
		await waitFor(activeWindow, (w) => w?.app === other.app, {
			label: `${label}で隠した後、前の窓にフォーカスが戻る`
		});
	}

	test('portal にホットキーを登録し、デスクトップがそのキーを押したと知らせると、下書きの窓を出し入れする', async (t) => {
		// GlobalShortcuts の portal が無いデスクトップ (GNOME 47 まで) では登録できず、mawok --toggle の案内に落ちる
		if (!(await hasGlobalShortcutsPortal())) {
			t.skip(`${desktopName()} には GlobalShortcuts の portal が無い`);
			return;
		}
		await waitLog(app.mark, 'hotkey registered with the desktop portal', 'portal への登録');
		assert.notEqual(
			await portalShortcutRegistered(),
			false,
			'portal に登録したホットキーが、デスクトップの一覧にある'
		);
		await bindHotkey('portal');
		await toggleTwice('portal のホットキー');
	});

	test('デスクトップのキー設定から mawok --toggle を呼ぶと、動いている Mawok が下書きの窓を出し入れする', async () => {
		await bindHotkey('toggle');
		await toggleTwice('mawok --toggle');
	});
});
