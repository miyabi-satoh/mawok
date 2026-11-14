import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSuite } from '../lib/setup.mjs';
import {
	clickElement,
	expectDraftStaysVisible,
	readDraft,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft
} from '../lib/app.mjs';
import { getDraftWindowHandle, getForegroundWindowHandle } from '../lib/os.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { isWindowAbove } from '../lib/window.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import {
	captureWindowsOnScreen,
	closeFileDialogIfAny,
	enterFileName,
	waitFileDialog,
	waitFileDialogClosed
} from '../lib/file-dialog.mjs';
import { waitFor } from '../lib/wait.mjs';

// テキストウィンドウの「開く」「保存」。読み書きの中身 (文字コード・行末) は cargo test と部品テストで見ているので、
// ここでは OS のファイルの窓とのつながりを見る。常に手前に出すテキストウィンドウより前に窓が出るか、窓を出している間に
// ほかのアプリへ移ったとして隠れないか、窓を閉じた後にフォーカスが入力欄へ戻るかは、OS の窓の扱いで決まるため。
// キーとボタンは本物の入力で押す (WebDriver の入力は OS から見たフォーカスの移り方が本物と違う)

const suite = createSuite();
// 撮った画面の置き場 (gitignore 済み)。描かれ方のテストが撮り直す前に消すのは `screenshots/` の直下の画面だけなので、フォルダーを分けて残す
const SCREENSHOT_DIR = path.resolve(import.meta.dirname, '..', 'screenshots', 'file-dialog');

test.describe('テキストウィンドウの開く・保存', () => {
	let testConfig;
	let client;
	let dir;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			showTextWindowButtons: true,
			textHistorySize: 50,
			hideTextWindowOnBlur: true,
			textWindowAlwaysOnTop: true
		});
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mawok-e2e-file-'));
	});
	test.after(async () => {
		try {
			await testConfig?.restore();
			if (dir) await fs.rm(dir, { recursive: true, force: true });
		} finally {
			await suite.after();
		}
	});

	test.beforeEach(async () => {
		client = await suite.newClient();
		await setJapanese(client);
	});
	test.afterEach(async () => {
		try {
			await closeFileDialogIfAny();
		} finally {
			await suite.closeClient(client);
		}
	});

	/**
	 * ファイルの窓が、テキストウィンドウに結び付いて前面に出て、テキストウィンドウより上にあり、出している間テキストウィンドウが隠れないことを見る
	 */
	async function expectDialogInFront(draftHwnd, label) {
		const dialog = await waitFileDialog(`${label}: ファイルの窓`);
		assert.equal(dialog.owner, draftHwnd, `${label}: 窓がテキストウィンドウに結び付いている`);
		await waitFor(getForegroundWindowHandle, (hwnd) => hwnd === dialog.hwnd, {
			label: `${label}: 窓が前面にある`
		});
		assert.ok(
			await isWindowAbove(dialog.hwnd, draftHwnd),
			`${label}: 窓が、常に手前に出すテキストウィンドウより上にある`
		);
		await expectDraftStaysVisible(`${label}: 窓を出している間`);
		return dialog;
	}

	/** 窓を閉じた後、テキストウィンドウが前面で、入力欄にフォーカスが戻ることを見る */
	async function expectFocusBack(draftHwnd, label) {
		await waitFileDialogClosed(`${label}: 窓が閉じる`);
		await waitFor(getForegroundWindowHandle, (hwnd) => hwnd === draftHwnd, {
			label: `${label}: テキストウィンドウが前面に戻る`
		});
		await waitFor(
			() => readDraft(client),
			(draft) => draft.focused,
			{ label: `${label}: 入力欄にフォーカスがある` }
		);
	}

	/** 入力欄の中身を、改行を含めて置く (WebDriver の打鍵では Enter が別の働きに取られうるため、画面の中で入れる) */
	async function setDraftText(text) {
		await client.execute((value) => {
			const textarea = document.querySelector('textarea');
			textarea.focus();
			textarea.value = value;
			textarea.dispatchEvent(new Event('input', { bubbles: true }));
		}, text);
	}

	test('Ctrl+O でファイルの窓が前に出て、選ぶとテキストが置き換わり、入力欄の先頭にカーソルがあって、前のテキストは履歴に入る', async () => {
		const file = path.join(dir, 'open-key.txt');
		await fs.writeFile(file, 'line1\r\nline2');
		await showDraftAndWaitVisible();
		const draftHwnd = await getDraftWindowHandle();
		await typeIntoDraft(client, 'before');

		await sendKeySequence([[VK.CONTROL, VK.O]]);
		const dialog = await expectDialogInFront(draftHwnd, 'Ctrl+O');
		// 窓がテキストウィンドウより前に出ている見た目を、人が目で見られるよう撮っておく
		await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
		await captureWindowsOnScreen(
			[draftHwnd, dialog.hwnd],
			path.join(SCREENSHOT_DIR, 'file-dialog-open.png')
		);
		await enterFileName(dialog.hwnd, file);
		await sendKeySequence([[VK.ENTER]]);

		await expectFocusBack(draftHwnd, '開いた後');
		// 読んだ中身は、窓が閉じた後に入る
		const draft = await waitFor(
			() => readDraft(client),
			(state) => state.value === 'line1\nline2',
			{ label: '読んだファイルの中身 (行末は LF になる)' }
		);
		assert.equal(draft.selectionStart, 0, '読んだ文の先頭にカーソルがある');

		// 前のテキストは「前」で戻せる
		await sendKeySequence([[VK.CONTROL, VK.ALT, VK.UP]]);
		await waitFor(
			() => readDraft(client),
			(state) => state.value === 'before',
			{ label: '前のテキストが履歴にある' }
		);
	});

	test('「開く...」のボタンでもファイルの窓が前に出て、選んだ後にそのまま打てる', async () => {
		const file = path.join(dir, 'open-button.txt');
		await fs.writeFile(file, 'opened');
		await showDraftAndWaitVisible();
		const draftHwnd = await getDraftWindowHandle();

		await clickElement(client, draftHwnd, await client.$('button[aria-label="開く..."]'));
		const dialog = await expectDialogInFront(draftHwnd, '開くのボタン');
		await enterFileName(dialog.hwnd, file);
		await sendKeySequence([[VK.ENTER]]);

		await expectFocusBack(draftHwnd, '開いた後');
		await sendKeySequence([[VK.X]]);
		await waitFor(
			() => readDraft(client),
			(draft) => draft.value === 'xopened',
			{ label: '打った文字が先頭に入る' }
		);
	});

	test('Ctrl+S で窓が前に出て、保存すると知らせが出て、ファイルは Windows の行末になり、そのまま打てる', async () => {
		const file = path.join(dir, 'saved.txt');
		await showDraftAndWaitVisible();
		const draftHwnd = await getDraftWindowHandle();
		await setDraftText('a\nb');

		await sendKeySequence([[VK.CONTROL, VK.S]]);
		const dialog = await expectDialogInFront(draftHwnd, 'Ctrl+S');
		await enterFileName(dialog.hwnd, file);
		await sendKeySequence([[VK.ENTER]]);

		await expectFocusBack(draftHwnd, '保存した後');
		await waitFor(
			() =>
				client.execute(() => document.querySelector('[role="status"]')?.textContent.trim() ?? null),
			(notice) => notice === '「saved.txt」に保存しました。',
			{ label: '保存の知らせ' }
		);
		assert.deepEqual(await fs.readFile(file), Buffer.from('a\r\nb'));

		await sendKeySequence([[VK.X]]);
		await waitFor(
			() => readDraft(client),
			(draft) => draft.value === 'a\nbx',
			{ label: '保存した後に打った文字が入る' }
		);
	});

	// キーで出すのは上で見たので、取り消しはボタンで出す
	for (const label of ['開く...', '保存...']) {
		test(`「${label}」のボタンで窓が前に出て、Esc で取り消すと、テキストウィンドウが残り、テキストはそのままで、続けて打てる`, async () => {
			await showDraftAndWaitVisible();
			const draftHwnd = await getDraftWindowHandle();
			await typeIntoDraft(client, 'keep');

			await clickElement(client, draftHwnd, await client.$(`button[aria-label="${label}"]`));
			await expectDialogInFront(draftHwnd, `「${label}」の窓`);
			await sendKeySequence([[VK.ESCAPE]]);

			await expectFocusBack(draftHwnd, '取り消した後');
			await expectDraftStaysVisible('取り消した後');
			await sendKeySequence([[VK.X]]);
			await waitFor(
				() => readDraft(client),
				(draft) => draft.value === 'keepx',
				{ label: '取り消した後に打った文字が入る' }
			);
		});
	}
});
