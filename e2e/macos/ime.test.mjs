import test from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_TITLE, SETTINGS_TITLE } from '../lib/app-conf.mjs';
import {
	KEY,
	copyAndHide,
	draftState,
	escapeComposition,
	focusWindowElement,
	getClipboard,
	hideDraft,
	holdUserState,
	isDraftVisible,
	isSettingsVisible,
	keyCode,
	launchOtherApp,
	openSettings,
	pressHotkey,
	pressInSettings,
	pressWindowElement,
	relaunchWithConfig,
	relaunchWithTestConfig,
	restoreUserState,
	setClipboard,
	showDraftWith,
	typeReading,
	waitDraftHidden,
	waitDraftValue,
	waitSettingsWindow
} from '../lib/macos.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';

// 日本語入力の変換中のキーを macOS 標準の日本語入力で見る。変換中かどうかの見分けは WKWebView のキーの届き方しだいで、
// Windows (WebView2 と Microsoft IME) とは別に確かめる要がある。ボタンの名前で押すので、日本語で起動する

test.describe('macOS: 日本語入力の変換中のキー', () => {
	let other;

	test.before(async () => {
		other = await launchOtherApp();
		await holdUserState();
		await relaunchWithTestConfig('language = "ja"\n', { clearHistory: true });
	});

	test.after(async () => {
		await keyCode(KEY.eisu).catch(() => {});
		await other?.close();
		await restoreUserState();
	});

	test('変換中の Esc は変換の取り消しになり、隠れない。変換が無くなってからの Esc で隠れる', async () => {
		await other.activate();
		await showDraftWith('abc');
		await typeReading('abc');
		await keyCode(KEY.space);
		await expectStays(isDraftVisible, true, { label: '変換した後、下書きウィンドウが出ているか' });
		await escapeComposition('abc', isDraftVisible);
		await hideDraft('変換が無くなってからの Esc で隠れる');
	});

	test('変換中の Cmd+Enter では隠れず、クリップボードも変わらない', async () => {
		await setClipboard('before-cmd-enter');
		await showDraftWith('abc');
		await typeReading('abc');
		await keyCode(KEY.return, ['command down']);
		await expectStays(isDraftVisible, true, { label: '変換中に Cmd+Enter を押した後' });
		assert.equal(await getClipboard(), 'before-cmd-enter');
		await escapeComposition('abc', isDraftVisible);
		await hideDraft();
	});

	test('変換中に「コピー」を押すと、未確定の文字も含めてコピーされる', async () => {
		await showDraftWith('abc');
		const composing = await typeReading('abc');
		await pressWindowElement(DRAFT_TITLE, 'AXButton', 'コピー');
		await waitDraftHidden('「コピー」で隠れる');
		await waitFor(getClipboard, (text) => text === composing, {
			label: '未確定の読みを含めてコピーされる'
		});
		await keyCode(KEY.eisu);
	});

	test('変換中にホットキーで隠すと、未確定の文字も含めてコピーされる', async () => {
		await showDraftWith('def');
		const composing = await typeReading('def');
		await pressHotkey();
		await waitDraftHidden('ホットキーで隠れる');
		await waitFor(getClipboard, (text) => text === composing, {
			label: '未確定の読みを含めてコピーされる'
		});
		await keyCode(KEY.eisu);
	});

	test('変換候補を出している間の ↑ は候補を選ぶだけで、履歴は出ない', async () => {
		// 履歴を1件だけにして始める。2件以上あると、↑ が誤って履歴へ移っても、続く ↑ で別の件へ移って見分けられない
		const entry = 'history-entry';
		await relaunchWithConfig(undefined, { clearHistory: true });
		await showDraftWith(entry);
		await copyAndHide(entry);

		await showDraftWith('');
		await typeReading();
		await keyCode(KEY.space);
		await keyCode(KEY.space);
		// 入力欄の ↑ は、カーソルが先頭に無ければ先頭へ動かすだけで、履歴は2回目から出るので、何回か送る
		for (let i = 1; i <= 3; i++) {
			await keyCode(KEY.up);
			await expectStays(async () => (await draftState()).value === entry, false, {
				label: `候補を出している間に ↑ を ${i} 回押した後、履歴の文が出ているか`
			});
		}
		await escapeComposition('', isDraftVisible);
		// 変換していない ↑ では履歴が出ることも見て、上の確かめが履歴のある状態で行われたことを裏付ける
		await keyCode(KEY.up);
		await waitDraftValue(entry);
		await hideDraft();
	});

	test('設定の置き換え辞書の欄で、変換中の Cmd+, と Esc では設定が閉じない', async () => {
		await openSettings('コピーの整え', '追加');
		await pressInSettings('AXButton', '追加');
		await focusWindowElement(SETTINGS_TITLE, 'AXTextField', '置き換える前の文字列');
		await typeReading();
		await keyCode(KEY.comma, ['command down']);
		await expectStays(isSettingsVisible, true, { label: '変換中に Cmd+, を押した後' });
		await escapeComposition('', isSettingsVisible);
		await keyCode(KEY.escape);
		await waitSettingsWindow(false, '変換が無くなってからの Esc で設定が閉じる');
	});
});
