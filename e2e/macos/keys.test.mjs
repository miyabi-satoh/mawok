import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_TITLE } from '../lib/app-conf.mjs';
import {
	KEY,
	closeSettings,
	copyAndHide,
	draftState,
	elementName,
	getClipboard,
	hideDraft,
	holdUserState,
	isDraftVisible,
	keyCode,
	openSettings,
	pressHotkey,
	pressInSettings,
	relaunchWithTestConfig,
	restoreUserState,
	setClipboard,
	showDraft,
	showDraftWith,
	waitDraftFocused,
	waitDraftHidden,
	waitDraftValue
} from '../lib/macos.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';

// ホットキーと下書きのキーを、設定画面の記録で変える。macOS では、ホットキーの登録 (Carbon) と、
// Cmd を使うキーの受け方が Windows と別の作りなので、本物のキー入力で記録して、そのキーで効くかを見る。
// 設定画面の要素の名前で押すので、日本語で起動する

// ほかのアプリがグローバルに取っていることの多い Cmd+Shift+〈文字〉は避ける (取られていると、記録に届かない)
const pressNewHotkey = () => keyCode(KEY.j, ['command down', 'option down', 'shift down']);
const pressNewCopyKey = () => keyCode(KEY.d, ['command down']);

/** メニューから設定を開き、「キー操作」の分類を出す */
const openKeySettings = () => openSettings('キー操作', 'ホットキーを変更');

/** 「〈prefix〉（今は …）」のボタンを押して記録を始め、`press` で送ったキーが記録されて名前が `expected` になるまで待つ */
async function record(prefix, press, expected) {
	await pressInSettings('AXButton', prefix);
	// 記録を始めると、ボタンは「キーを押してください」の表示に替わる
	await waitFor(
		() => elementName(SETTINGS_TITLE, 'AXButton', prefix),
		(name) => name === null,
		{
			label: `${prefix} の記録が始まる`
		}
	);
	await press();
	await waitFor(
		() => elementName(SETTINGS_TITLE, 'AXButton', prefix),
		(name) => name?.includes(`（今は ${expected}）`),
		{ label: `${prefix} が ${expected} になる` }
	);
}

test.describe('macOS: ホットキーと下書きのキーの変更', () => {
	test.before(async () => {
		await holdUserState();
		await relaunchWithTestConfig('language = "ja"\n');
	});

	test.after(async () => {
		await restoreUserState();
	});

	test('5. の 2.: ホットキーを別の組み合わせにすると、そのキーで下書きが出て、元のキーでは出ない', async () => {
		await openKeySettings();
		await record('ホットキーを変更', pressNewHotkey, '⌘⌥⇧J');
		// 登録したその場で効くことを、設定を閉じる前に見る (閉じるときに登録し直すので、閉じた後だけでは見分けられない)
		await pressNewHotkey();
		await waitDraftFocused('設定を開いたまま、登録した組み合わせで下書きが出る');
		await hideDraft();
		await closeSettings();

		await pressHotkey();
		await expectStays(isDraftVisible, false, { label: '元のホットキーを押した後', duration: 1500 });
		await pressNewHotkey();
		await waitDraftFocused('登録した組み合わせで下書きが出る');
		await hideDraft();
	});

	test('5. の 4.: 既定の組み合わせを記録し直すと、既定のキーで出る', async () => {
		await openKeySettings();
		assert.match(
			await elementName(SETTINGS_TITLE, 'AXButton', 'ホットキーを変更'),
			/（今は ⌘⌥⇧J）/,
			'既定でない組み合わせから始める'
		);
		await record('ホットキーを変更', pressHotkey, '⌘⇧Space');
		await closeSettings();
		await showDraft();
		await hideDraft();
	});

	test('20. の 2.: 「コピーして閉じる」のキーを変えると、そのキーでコピーして隠れ、元のキーでは隠れない', async () => {
		await openKeySettings();
		await record('コピーして閉じるのキーを変更', pressNewCopyKey, '⌘D');
		await closeSettings();

		await setClipboard('before-keys');
		await showDraftWith('newkey');
		await keyCode(KEY.return, ['command down']);
		await expectStays(isDraftVisible, true, { label: '元のキー (Cmd+Enter) を押した後' });
		assert.equal(await getClipboard(), 'before-keys', '元のキーではコピーしない');
		// 元のキーで改行が入っていれば消してから、変えたキーでコピーする
		if ((await draftState()).value !== 'newkey') {
			await keyCode(KEY.delete);
			await waitDraftValue('newkey');
		}
		await pressNewCopyKey();
		await waitDraftHidden('変えたキーでコピーして隠れる');
		await waitFor(getClipboard, (text) => text === 'newkey', { label: 'クリップボード' });
	});

	test('20. の 4.: 記録中の「既定に戻す」で、既定のキーでコピーして隠れる', async () => {
		await openKeySettings();
		// 既定のままだと「既定に戻す」は押せず、押しても何も起きないまま通ってしまう
		assert.match(
			await elementName(SETTINGS_TITLE, 'AXButton', 'コピーして閉じるのキーを変更'),
			/（今は ⌘D）/,
			'既定でないキーから始める'
		);
		await pressInSettings('AXButton', 'コピーして閉じるのキーを変更');
		await pressInSettings('AXButton', '既定に戻す');
		await waitFor(
			() => elementName(SETTINGS_TITLE, 'AXButton', 'コピーして閉じるのキーを変更'),
			(name) => name?.includes('（今は ⌘Enter）'),
			{ label: '「コピーして閉じる」が既定に戻る' }
		);
		await closeSettings();

		await showDraftWith('default');
		await copyAndHide('default');
	});
});
