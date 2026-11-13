import test from 'node:test';
import assert from 'node:assert/strict';
import { MANUAL_TITLE, SETTINGS_TITLE, TRAY_MENU_JA } from '../lib/app-conf.mjs';
import {
	activeWindow,
	closeApp,
	draftFocused,
	ensureSessionEnv,
	launchApp,
	launchOtherWindow,
	mawokPids,
	mawokWindows,
	pressTrayItem,
	startDriver,
	trayMenu,
	waitDraftVisible
} from '../lib/linux.mjs';
import { waitFor } from '../lib/wait.mjs';

// トレイのアイコンを、デスクトップのパネルが使う D-Bus (StatusNotifierItem と dbusmenu) から見て押す。
// Linux のトレイは libayatana-appindicator の作りで、Windows のタスクトレイ・macOS のメニューバーとは別に見る。
// 項目の名前で押すので、日本語で起動する

test.describe('Linux: トレイ', () => {
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
	});

	test('メニューの項目が、表示／非表示・設定…・使い方・区切り・終了の順に並ぶ', async () => {
		const items = await waitFor(trayMenu, (menu) => menu.length > 0, {
			label: 'トレイのメニューの読み込み'
		});
		assert.deepEqual(
			items.map(({ label }) => label),
			[
				TRAY_MENU_JA.toggleDraft,
				TRAY_MENU_JA.settings,
				TRAY_MENU_JA.manual,
				null,
				TRAY_MENU_JA.quit
			]
		);
		assert.ok(
			items.every(({ enabled }) => enabled),
			'どの項目も押せる'
		);
	});

	test('「テキストウィンドウを表示／非表示」で下書きの窓が出て入力欄にフォーカスが入り、もう一度押すと隠れて前の窓に戻る', async () => {
		await other.focus();
		await waitFor(activeWindow, (w) => w?.app === other.app, { label: 'ほかの窓にフォーカス' });
		await pressTrayItem(TRAY_MENU_JA.toggleDraft);
		await waitDraftVisible(true, 'トレイから出した下書きの窓');
		await waitFor(activeWindow, (w) => w?.app === 'mawok', {
			label: 'トレイから出した下書きの窓にフォーカスが移る'
		});
		await waitFor(() => draftFocused(app.client), Boolean, {
			label: 'トレイから出した下書きの入力欄にフォーカスが入る'
		});
		await pressTrayItem(TRAY_MENU_JA.toggleDraft);
		await waitDraftVisible(false, 'トレイからもう一度押して下書きの窓が隠れる');
		await waitFor(activeWindow, (w) => w?.app === other.app, {
			label: 'トレイから隠した後、前の窓にフォーカスが戻る'
		});
	});

	test('「設定…」で設定の窓が開く', async () => {
		await pressTrayItem(TRAY_MENU_JA.settings);
		await waitFor(
			() => mawokWindows(SETTINGS_TITLE),
			(w) => w.length === 1,
			{
				label: 'トレイから開いた設定の窓'
			}
		);
		await waitFor(activeWindow, (w) => w?.title === SETTINGS_TITLE, {
			label: '開いた設定の窓にフォーカスが移る'
		});
	});

	test('「使い方」で使い方の窓が開く', async () => {
		await pressTrayItem(TRAY_MENU_JA.manual);
		await waitFor(
			() => mawokWindows(MANUAL_TITLE),
			(w) => w.length === 1,
			{
				label: 'トレイから開いた使い方の窓'
			}
		);
	});

	test('「終了」で Mawok が終わる', async () => {
		await pressTrayItem(TRAY_MENU_JA.quit);
		await waitFor(mawokPids, (pids) => pids.length === 0, {
			timeout: 10_000,
			label: 'トレイの「終了」で Mawok のプロセスが終わる'
		});
	});
});
