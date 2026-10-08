import test from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_TITLE, SETTINGS_MIN_SIZE, SETTINGS_TITLE, TRAY_MENU_JA } from '../lib/app-conf.mjs';
import {
	KEY,
	closeSettings,
	elementFrames,
	hideDraft,
	isDraftVisible,
	isSettingsVisible,
	frontmostApp,
	getClipboard,
	holdUserState,
	keyCode,
	keystroke,
	launchOtherApp,
	openSettings,
	pressInSettings,
	pressHotkey,
	pressTrayMenuItem,
	pressWindowElement,
	relaunchWithTestConfig,
	restoreUserState,
	setClipboard,
	setWindowFrame,
	showDraftWith,
	waitDraftFocused,
	waitDraftHidden,
	waitSettingsWindow,
	windowFrame
} from '../lib/macos.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';

// 設定ウィンドウを開け閉めしたときの、下書きウィンドウとフォーカスの動きを macOS で見る。
// 隠し方とフォーカスの戻し方が OS ごとに別の作りなので、Windows の E2E とは別に見る。
// メニューの項目の名前で押すので、日本語で起動する

/** 下書きに書いて、Cmd+, で設定を開く。書くのは英数で (日本語入力のままだと、Cmd+, も変換中の操作になる) */
async function openSettingsFromDraft(text) {
	await showDraftWith(text);
	await keyCode(KEY.comma, ['command down']);
	await waitSettingsWindow(true);
}

test.describe('macOS: 設定ウィンドウ', () => {
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

	test('4. の 1.: 下書きに書いて Cmd+, を押すと、設定が開いて下書きウィンドウが隠れ、クリップボードは変わらない', async () => {
		await setClipboard('before-settings');
		await openSettingsFromDraft('kakikake');
		await waitDraftHidden('設定を開くと、下書きウィンドウが隠れる');
		assert.equal(await getClipboard(), 'before-settings');
	});

	test('4. の 2.: 設定を Esc で閉じると、下書きウィンドウが書きかけのまま出し直され、入力欄にフォーカスがある', async () => {
		await keyCode(KEY.escape);
		await waitSettingsWindow(false);
		const shown = await waitDraftFocused('設定を閉じると、下書きウィンドウが出し直される');
		assert.equal(shown.value, 'kakikake');
	});

	test('4. の 2.: Cmd+W で閉じても同じ', async () => {
		await keyCode(KEY.comma, ['command down']);
		await waitSettingsWindow(true);
		await waitDraftHidden();
		await keyCode(KEY.w, ['command down']);
		await waitSettingsWindow(false);
		const shown = await waitDraftFocused('設定を閉じると、下書きウィンドウが出し直される');
		assert.equal(shown.value, 'kakikake');
		await hideDraft();
	});

	test('4. の 3.: 下書きウィンドウを隠したままメニューから設定を開いて閉じると、下書きは出ず、前のアプリに戻る', async () => {
		assert.equal(await isDraftVisible(), false, '下書きウィンドウが隠れた状態から始める');
		await other.activate();
		await openSettings();
		await keyCode(KEY.w, ['command down']);
		await waitSettingsWindow(false);
		await expectStays(isDraftVisible, false, { label: '設定を閉じた後' });
		await waitFor(frontmostApp, (name) => name === other.name, {
			label: `前のアプリ (${other.name}) が前面に戻る`
		});
	});

	test('4. の 4.: 設定を開いた後にホットキーで下書きを出し、設定を閉じても、下書きは出たまま', async () => {
		await openSettings();
		await pressHotkey();
		await waitDraftFocused('設定を開いたまま、ホットキーで下書きが出る');
		await closeSettings();
		await waitDraftFocused('設定を閉じた後も、下書きにフォーカスが戻る');
		await expectStays(isDraftVisible, true, { label: '設定を閉じた後' });
		await hideDraft();
	});

	test('4. の 5.: 設定を開いたまま下書きで Cmd+, を押すと設定が閉じ、メニューの「設定…」は前に出すだけで閉じない', async () => {
		await openSettings();
		await pressTrayMenuItem(TRAY_MENU_JA.settings);
		await expectStays(isSettingsVisible, true, { label: 'もう一度メニューの「設定…」を押した後' });
		await pressHotkey();
		await waitDraftFocused('設定を開いたまま、ホットキーで下書きが出る');
		await keyCode(KEY.eisu);
		await keyCode(KEY.comma, ['command down']);
		await waitSettingsWindow(false, '下書きの Cmd+, で設定ウィンドウが閉じる');
		await waitDraftFocused('設定が閉じた後も、下書きの入力欄にフォーカスが残る');
		await hideDraft();
	});

	test('4. の 6.: 最小より小さくならず、閉じて開き直すと同じ位置と大きさで出る', async () => {
		await openSettings();
		const opened = await windowFrame(SETTINGS_TITLE);

		// macOS では、最小の大きさで枠 (タイトルバーを含む) が止まる (実機で読んだ値)
		await setWindowFrame(SETTINGS_TITLE, { ...opened, width: 200, height: 150 });
		const shrunk = await windowFrame(SETTINGS_TITLE);
		assert.deepEqual(
			{ width: shrunk.width, height: shrunk.height },
			SETTINGS_MIN_SIZE,
			'縮めると、最小の大きさで止まる'
		);

		const moved = { x: opened.x + 40, y: opened.y + 30, width: 700, height: 520 };
		await setWindowFrame(SETTINGS_TITLE, moved);
		await waitFor(
			() => windowFrame(SETTINGS_TITLE),
			(f) => f.width === moved.width && f.height === moved.height,
			{ label: '大きさが変わる' }
		);
		const before = await windowFrame(SETTINGS_TITLE);
		await keyCode(KEY.w, ['command down']);
		await waitSettingsWindow(false);

		await openSettings();
		assert.deepEqual(await windowFrame(SETTINGS_TITLE), before, '閉じる前と同じ位置と大きさ');
		await keyCode(KEY.w, ['command down']);
		await waitSettingsWindow(false);
	});

	// 前面に出ることは見ない。歯車で下書きが隠れると、残る Mawok のウィンドウは設定だけなので、前に出す処理が効かなくても前面になる
	test('設定を開いたまま下書きの歯車ボタンを押しても、設定は閉じない', async () => {
		await openSettings();
		await pressHotkey();
		await waitDraftFocused('設定を開いたまま、ホットキーで下書きが出る');
		await pressWindowElement(DRAFT_TITLE, 'AXButton', '設定');
		await waitDraftHidden('歯車ボタンを押すと、下書きウィンドウが隠れる');
		await expectStays(isSettingsVisible, true, { label: '歯車ボタンを押した後' });
		await keyCode(KEY.w, ['command down']);
		await waitSettingsWindow(false);
		await waitDraftFocused('設定を閉じると、下書きウィンドウが出し直される');
		await hideDraft();
	});

	// 行を足した設定は、片付けで控えた設定に戻る
	test('置き換え辞書の行を増やしても、ウィンドウは伸びず、右の区画がスクロールする', async () => {
		await openSettings('コピーの整え', '追加');
		const before = await windowFrame(SETTINGS_TITLE);
		// 空の行が残っていると「追加」は新しく足さないので、足すたびに1文字書く。英数で打つ
		await keyCode(KEY.eisu);
		let firstTop;
		for (let i = 0; i < 15; i++) {
			await pressInSettings('AXButton', '追加');
			await keystroke('r');
			if (i === 0) {
				const [first] = await waitFor(
					() => elementFrames(SETTINGS_TITLE, 'AXTextField', '置き換える前の文字列'),
					(frames) => frames.length >= 1,
					{ label: '置き換え辞書の行ができる' }
				);
				firstTop = first.y;
			}
		}
		const rows = await waitFor(
			() => elementFrames(SETTINGS_TITLE, 'AXTextField', '置き換える前の文字列'),
			(frames) => frames.length >= 15,
			{ label: '置き換え辞書の行が増える' }
		);
		assert.deepEqual(
			await windowFrame(SETTINGS_TITLE),
			before,
			'ウィンドウの位置と大きさは変わらない'
		);
		// 書いている欄は見える所へスクロールされるので、窓が伸びずに最初の行が上へずれていれば、
		// 区画の中でスクロールして見る形になっている。
		// ページごとのスクロールにならないことは、両 OS に共通の CSS なので Windows の描かれ方の確認で見る
		assert.ok(
			rows[0].y < firstTop,
			`最初の行が上へずれている (行の上端 ${firstTop} → ${rows[0].y})`
		);
		await keyCode(KEY.w, ['command down']);
		await waitSettingsWindow(false);
	});
});
