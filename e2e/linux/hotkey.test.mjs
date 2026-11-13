import test from 'node:test';
import assert from 'node:assert/strict';
import {
	PORTAL_SHORTCUT,
	activeWindow,
	bindHotkey,
	closeApp,
	draftFocused,
	ensureSessionEnv,
	globalShortcuts,
	launchApp,
	launchOtherWindow,
	pressHotkey,
	startDriver,
	unbindHotkey,
	waitDraftVisible,
	waitLog
} from '../lib/linux.mjs';
import { waitFor } from '../lib/wait.mjs';

// Wayland ではアプリがキーを奪えないので、ホットキーは portal に登録するか (portal_hotkey.rs)、デスクトップのキー設定から
// `mawok --toggle` を呼んでもらう (toggle.rs)。Hyprland の portal は登録を受けても自分ではキーを付けないので、
// どちらの道も Hyprland の割り当てを替えて、ydotool で本物のキーを押して見る

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
		await waitFor(activeWindow, (w) => w?.class === other.class, { label: 'ほかの窓にフォーカス' });
		await pressHotkey();
		await waitDraftVisible(true, `${label}で下書きの窓が出る`);
		await waitFor(activeWindow, (w) => w?.class === 'mawok', {
			label: `${label}で出した下書きの窓にフォーカスが移る`
		});
		await waitFor(() => draftFocused(app.client), Boolean, {
			label: `${label}で出した下書きの入力欄にフォーカスが入る`
		});
		await pressHotkey();
		await waitDraftVisible(false, `${label}をもう一度押して下書きの窓が隠れる`);
		await waitFor(activeWindow, (w) => w?.class === other.class, {
			label: `${label}で隠した後、前の窓にフォーカスが戻る`
		});
	}

	test('portal にホットキーを登録し、デスクトップがそのキーを押したと知らせると、下書きの窓を出し入れする', async () => {
		await waitLog(app.mark, 'hotkey registered with the desktop portal', 'portal への登録');
		assert.ok(
			(await globalShortcuts()).includes(PORTAL_SHORTCUT),
			`${PORTAL_SHORTCUT} が Hyprland の global shortcuts にある`
		);
		await bindHotkey('portal');
		await toggleTwice('portal のホットキー');
	});

	test('デスクトップのキー設定から mawok --toggle を呼ぶと、動いている Mawok が下書きの窓を出し入れする', async () => {
		await bindHotkey('toggle');
		await toggleTwice('mawok --toggle');
	});
});
