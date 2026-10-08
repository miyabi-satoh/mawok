import test from 'node:test';
import assert from 'node:assert/strict';
import { TRAY_MENU_JA } from '../lib/app-conf.mjs';
import {
	KEY,
	frontmostApp,
	getClipboard,
	hideDraft,
	holdUserState,
	isDraftVisible,
	isTrayMenuOpen,
	keyCode,
	keystroke,
	launchOtherApp,
	mawokPids,
	openSettings,
	openTrayMenu,
	pressHotkey,
	pressTrayMenuItem,
	relaunchWithTestConfig,
	restoreUserState,
	setClipboard,
	showDraft,
	trayMenuKeys,
	waitDraftFocused,
	waitDraftHidden,
	waitDraftValue,
	waitSettingsWindow
} from '../lib/macos.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';

// メニューバーのアイコンのメニューを macOS で見る。トレイは OS ごとに別の作り (Windows はタスクトレイ) なので、
// Windows の E2E とは別に見る。項目の名前で押すので、日本語で起動する

test.describe('macOS: メニューバー', () => {
	let other;

	test.before(async () => {
		other = await launchOtherApp();
		await holdUserState();
		await relaunchWithTestConfig('language = "ja"\n');
	});

	test.after(async () => {
		await other?.close();
		await restoreUserState();
	});

	test('アイコンを押すとメニューが出て、「テキストウィンドウを表示／隠す」に ⌘⇧Space が添えてあり、押すと下書きウィンドウが出る', async () => {
		await openTrayMenu();
		await waitFor(isTrayMenuOpen, Boolean, { label: 'アイコンを押すとメニューが開く' });
		const items = await trayMenuKeys();
		await keyCode(KEY.escape);
		await waitFor(isTrayMenuOpen, (open) => !open, { label: 'Esc でメニューが閉じる' });
		assert.deepEqual(
			items.map(({ name }) => name),
			[
				TRAY_MENU_JA.toggleDraft,
				TRAY_MENU_JA.settings,
				TRAY_MENU_JA.manual,
				null,
				TRAY_MENU_JA.quit
			]
		);
		// Command を前提に、1 は Shift を足し、8 は Command も無い (キーを添えていない)
		assert.deepEqual(
			items.map(({ key, modifiers }) => [key, modifiers]),
			[
				[' ', 1],
				[null, 8],
				[null, 8],
				[null, 0],
				[null, 8]
			]
		);

		await pressTrayMenuItem(TRAY_MENU_JA.toggleDraft);
		await waitDraftFocused('メニューから出した下書きウィンドウ');
		await hideDraft();
	});

	test('下書きに書いてからメニューの「テキストウィンドウを表示／隠す」を押すと、隠れてクリップボードは変わらず、出し直すと書きかけが残っている', async () => {
		await other.activate();
		await pressTrayMenuItem(TRAY_MENU_JA.toggleDraft);
		await waitDraftFocused('メニューから出した下書きウィンドウ');
		await keyCode(KEY.eisu);
		await keystroke('kakikake');
		await waitDraftValue('kakikake');
		await setClipboard('before-tray');
		await pressTrayMenuItem(TRAY_MENU_JA.toggleDraft);
		await waitDraftHidden('メニューから隠す');
		assert.equal(await getClipboard(), 'before-tray', 'メニューから隠しても、コピーはしない');
		await waitFor(frontmostApp, (name) => name === other.name, {
			label: 'メニューから隠すと、前のアプリが前面に戻る'
		});

		await pressTrayMenuItem(TRAY_MENU_JA.toggleDraft);
		const shown = await waitDraftFocused('メニューから出し直した下書きウィンドウ');
		assert.equal(shown.value, 'kakikake');
		await hideDraft();
	});

	test('アプリを前面にしたままメニューから下書きウィンドウを出し、Esc で隠すと、フォーカスがそのアプリに戻る', async () => {
		await other.activate();
		await pressTrayMenuItem(TRAY_MENU_JA.toggleDraft);
		await waitDraftFocused('メニューから出した下書きウィンドウ');
		await hideDraft();
		await waitFor(frontmostApp, (name) => name === other.name, {
			label: 'Esc で隠すと、前のアプリが前面に戻る'
		});
	});

	test('メニューを開いている間に押したホットキーは、閉じた後に届かない', async () => {
		// 開いたメニューでホットキーを押すと、同じキーを添えた「テキストウィンドウを表示／隠す」が選ばれて、下書きウィンドウが出る。
		// 開いている間もホットキーが登録されたままだと、キーがメニューに届かずに溜まり、メニューは閉じない
		// (src-tauri/src/menu_tracking.rs)
		assert.equal(await isDraftVisible(), false, '始める前は、下書きウィンドウが隠れている');
		await openTrayMenu();
		await waitFor(isTrayMenuOpen, Boolean, { label: 'メニューが開く' });
		await pressHotkey();
		await waitFor(isTrayMenuOpen, (open) => !open, { label: 'メニューが閉じる' });
		await waitDraftFocused('メニューの項目で出た下書きウィンドウ');
		await expectStays(isDraftVisible, true, {
			label: 'メニューが閉じた後に、溜まったホットキーで隠れないか',
			duration: 1500
		});

		// 閉じた後は、ホットキーがふだんどおり効く
		await pressHotkey();
		await waitDraftHidden('閉じた後のホットキーで隠れる');
	});

	test('ほかのアプリに移っても隠さない設定で、出したままほかのアプリに移ってからメニューで隠すと、そのアプリが前面のまま', async () => {
		await relaunchWithTestConfig('language = "ja"\nhide_text_window_on_blur = false\n');
		await showDraft();
		await other.clickWindow();
		assert.equal(
			await isDraftVisible(),
			true,
			'ほかのアプリに移っても、下書きウィンドウは出たまま'
		);
		await pressTrayMenuItem(TRAY_MENU_JA.toggleDraft);
		await waitDraftHidden('メニューから隠す');
		await expectStays(frontmostApp, other.name, {
			label: '隠した後も、ほかのアプリが前面のままか'
		});
		await relaunchWithTestConfig('language = "ja"\n');
	});

	test('メニューの「設定…」で設定ウィンドウが出て、「終了」で終了する', async () => {
		await openSettings();
		await keyCode(KEY.escape);
		await waitSettingsWindow(false);

		await pressTrayMenuItem(TRAY_MENU_JA.quit);
		await waitFor(mawokPids, (pids) => pids.length === 0, { label: '「終了」で終了する' });
	});
});
