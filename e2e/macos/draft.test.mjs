import test from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_TITLE } from '../lib/app-conf.mjs';
import {
	KEY,
	click,
	copyAndHide,
	draftPoints,
	draftState,
	elementCenter,
	frontmostApp,
	getClipboard,
	hideDraft,
	holdUserState,
	isDraftVisible,
	keyCode,
	keystroke,
	launchPasteTarget,
	pasteIntoTarget,
	pasteboardTypes,
	pasteTargetPoint,
	pasteTargetText,
	pressCloseButton,
	pressHotkey,
	relaunchWithConfig,
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

// 出す・書く・コピーする操作のうち、OS ごとに作りが分かれている項目を macOS で見る
// (フォーカスの戻し方、クリップボードへの書き込み、隠し方、初めての起動)。両 OS に共通の項目は
// Windows の E2E に任せる。
//
// 打つ文字は ASCII にする。System Events の keystroke は、文字をキーに置き換えて送るため

// クリップボードの履歴・管理アプリに残さない印 (nspasteboard.org の慣習。arboard の exclude_from_history が置く)
const CONCEALED_TYPE = 'org.nspasteboard.ConcealedType';

const REPLACEMENT_CONFIG = '[[replacements]]\nfrom = "濃度"\nto = "Node.js"\n';

test.describe('macOS: 出す・書く・コピーする', () => {
	let target;

	test.before(async () => {
		// TextEdit が動いていれば、常用の Mawok を止める前に落ちるよう、先に開く
		target = await launchPasteTarget();
		await holdUserState();
		await relaunchWithTestConfig();
	});

	test.after(async () => {
		await target?.close();
		await restoreUserState();
	});

	test('1. の 2.〜5.: 出して書いてコピーすると、前のアプリに戻り、末尾の改行なしで貼り付く', async () => {
		await target.activate();
		const shown = await showDraft();
		assert.equal(shown.value, '', '起動したばかりの入力欄は空');

		await keystroke('git status');
		await keyCode(KEY.return);
		await waitDraftValue('git status\n');
		await keyCode(KEY.return, ['command down']);
		await waitDraftHidden();
		assert.equal(await frontmostApp(), 'TextEdit', 'フォーカスが前のアプリに戻る');
		await waitFor(getClipboard, (text) => text === 'git status', { label: 'クリップボード' });

		await pasteIntoTarget();
		await waitFor(pasteTargetText, (text) => text === 'git status', {
			label: '貼り付け先の本文 (末尾の改行なし)'
		});
	});

	test('1. の 7.: Esc で隠すとフォーカスが戻り、クリップボードは変わらない', async () => {
		await showDraftWith('kakikake');
		await hideDraft();
		assert.equal(await frontmostApp(), 'TextEdit');
		assert.equal(await getClipboard(), 'git status');
		await pasteIntoTarget();
		await waitFor(pasteTargetText, (text) => text === 'git status', { label: '貼り付け先の本文' });
	});

	test('1. の 8.: 書きかけが残り、閉じるボタンで隠して出し直しても残る', async () => {
		const shown = await showDraft();
		assert.equal(shown.value, 'kakikake');
		await pressCloseButton(DRAFT_TITLE);
		await waitDraftHidden();
		const again = await showDraft();
		assert.equal(again.value, 'kakikake');
	});

	test('1. の 11.: 入力欄とタイトルバーのクリック、IME の変換候補では隠れない', async () => {
		const points = await draftPoints();
		await click(points.input);
		await expectStays(isDraftVisible, true, { label: '入力欄をクリックした後' });
		await click(points.title);
		await expectStays(isDraftVisible, true, { label: 'タイトルバーをクリックした後' });
		await waitDraftFocused('タイトルバーをクリックした後も、入力欄にフォーカスがある');

		// 日本語入力に切り替えて変換し、もう一度 Space で候補の一覧を出す
		await keyCode(KEY.kana);
		try {
			await keystroke('nihon');
			await keyCode(KEY.space);
			await keyCode(KEY.space);
			await expectStays(isDraftVisible, true, { label: '変換候補を出した後' });
			assert.equal(await frontmostApp(), 'mawok');
			// 変換を取り消す (1回目で読みに戻り、2回目で消える)
			await keyCode(KEY.escape);
			await keyCode(KEY.escape);
		} finally {
			await keyCode(KEY.eisu);
		}
		await waitDraftValue('kakikake');
		assert.ok((await draftState()).visible, '変換を取り消した後も、下書きウィンドウが出ている');
	});

	test('1. の 9.: ほかのアプリをクリックすると隠れ、クリップボードは変わらず、書きかけが残る', async () => {
		assert.ok((await draftState()).visible, 'クリックする前に、下書きウィンドウが出ている');
		await setClipboard('before-blur');
		await click(await pasteTargetPoint());
		await waitDraftHidden('ほかのアプリをクリックして、下書きウィンドウが隠れる');
		assert.equal(await frontmostApp(), 'TextEdit', 'クリックしたアプリが前面のまま');
		assert.equal(await getClipboard(), 'before-blur');
		const shown = await showDraft();
		assert.equal(shown.value, 'kakikake');
	});

	test('1. の 10.: 「ほかのアプリに移ったら隠す」がオフなら、ほかのアプリをクリックしても出たまま', async () => {
		await relaunchWithTestConfig('hide_text_window_on_blur = false\n');
		await target.activate();
		await showDraft();
		await click(await pasteTargetPoint());
		await waitFor(frontmostApp, (name) => name === 'TextEdit', {
			label: 'クリックしたアプリの前面'
		});
		await expectStays(isDraftVisible, true, { label: 'ほかのアプリをクリックした後' });
		await pressHotkey();
		await waitDraftFocused();
		await hideDraft();
	});

	test('「コピー」のボタンを押すと、隠れて前のアプリに戻って貼り付き、出し直すと履歴の前・次の列が出る', async () => {
		// ボタンを日本語の名前で探すので、OS の言語によらず日本語にする
		await relaunchWithTestConfig('language = "ja"\n', { clearHistory: true });
		await target.activate();
		await showDraft();
		assert.equal(
			await elementCenter(DRAFT_TITLE, 'AXButton', '前'),
			null,
			'履歴が無いうちは、前・次の列が無い'
		);
		await keystroke('git log');
		await waitDraftValue('git log');
		// ボタンのクリックで入力欄からフォーカスが外れても、前のアプリに戻ることを見るので、本物のマウスで押す
		await click(await elementCenter(DRAFT_TITLE, 'AXButton', 'コピー'));
		await waitDraftHidden();
		assert.equal(await frontmostApp(), 'TextEdit', 'フォーカスが前のアプリに戻る');
		await waitFor(getClipboard, (text) => text === 'git log', { label: 'クリップボード' });
		await pasteIntoTarget();
		await waitFor(pasteTargetText, (text) => text === 'git log', { label: '貼り付け先の本文' });

		await showDraft();
		assert.ok(await elementCenter(DRAFT_TITLE, 'AXButton', '前'), '前のボタンが出る');
		assert.ok(await elementCenter(DRAFT_TITLE, 'AXButton', '次'), '次のボタンが出る');
		await hideDraft();
	});

	// 置き換えの決まりは両 OS に共通だが、ほかのテストは ASCII しか打てないので、日本語を含む文が macOS の
	// クリップボードへの書き込みを通って貼り付くことを、ここで見る
	test('置き換え辞書の語を書いてコピーすると、置き換えた文が貼り付く', async () => {
		await relaunchWithTestConfig(REPLACEMENT_CONFIG);
		// System Events の keystroke では日本語を打てないので、貼り付けて書く
		await showDraftWith('濃度のバージョン', { paste: true });
		await copyAndHide('Node.jsのバージョン');
		await pasteIntoTarget();
		await waitFor(pasteTargetText, (text) => text === 'Node.jsのバージョン', {
			label: '貼り付け先の本文'
		});
	});

	test('コピーには、クリップボードの履歴に残さない印が付き、設定をオフにすると付かない', async () => {
		for (const [extra, text, concealed] of [
			['', 'concealed', true],
			['exclude_from_clipboard_history = false\n', 'plain', false]
		]) {
			await relaunchWithTestConfig(extra);
			await showDraftWith(text);
			await copyAndHide(text);
			assert.equal(
				(await pasteboardTypes()).includes(CONCEALED_TYPE),
				concealed,
				concealed ? '既定では印が付く' : 'オフなら印が付かない'
			);
		}
	});

	test('1. の 13.: 設定ファイルが無い初めての起動で出てフォーカスが入り、2回目は出ない', async () => {
		await relaunchWithConfig(null);
		const shown = await waitDraftFocused(
			'初めての起動で、下書きウィンドウが出て入力欄にフォーカスが入る'
		);
		assert.ok(shown.placeholder, '入力欄の案内がある');
		// 起動した設定ファイルのまま、もう一度起動する
		await relaunchWithConfig();
		await expectStays(isDraftVisible, false, { label: '2回目の起動', duration: 3000 });
	});
});
