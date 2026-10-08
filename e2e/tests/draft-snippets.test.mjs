import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	expectDraftStaysVisible,
	invokeApp,
	openSettingsFromDraft,
	readDraft,
	readSnippetPalette,
	ROW_TOGGLE,
	setDraftCaret,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitDraftHidden,
	waitForWindowCount
} from '../lib/app.mjs';
import {
	getDraftWindowHandle,
	getForegroundWindowHandle,
	listVisibleMawokTreeWindows
} from '../lib/os.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { turnImeOff, turnImeOn, typeRomaji } from '../lib/ime.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import { launchPasteTarget } from '../lib/paste-target.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';

// 定型文。絞り込みと差し込む位置は部品テストで見ているので、ここでは実際の WebView での
// キー (本物の入力の Ctrl+J・Enter・Esc・Ctrl+Z)、IME、ほかのアプリに移ったときを見る。
// 定型文は設定画面ではなく config.toml で登録する (設定画面の表の操作は部品テストで見ている)。
// IME で絞り込む名前はひらがなにする。漢字だと変換の結果しだいで絞り込みに当たらなくなるため

const suite = createSuite();
const BODY = '一つずつ質問してください。\n以上です。';
const SNIPPETS = [
	{ name: 'かくにん', body: BODY },
	{ name: '', body: 'git status' }
];

/** 下書きを出して「あいう」と書き、「い」と「う」の間にカーソルを置く */
async function prepareDraft(client) {
	await showDraftAndWaitVisible();
	await typeIntoDraft(client, 'あいう');
	await setDraftCaret(client, 2);
}

/** 定型文の一覧が出たまま (閉じない) であることを、しばらく見続ける */
function expectPaletteStaysOpen(client, label) {
	return expectStays(async () => (await readSnippetPalette(client)).open, true, {
		label,
		duration: 700
	});
}

async function openPalette(client) {
	await sendKeySequence([[VK.CONTROL, VK.J]]);
	return waitFor(
		() => readSnippetPalette(client),
		(palette) => palette.open && palette.inputFocused,
		{ label: 'Ctrl+J で一覧が出て、絞り込みの欄にフォーカスがある' }
	);
}

test.describe('定型文', () => {
	let testConfig;
	let client;
	let pasteTarget;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			hideTextWindowOnBlur: true,
			textWindowAlwaysOnTop: true,
			snippets: SNIPPETS
		});
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
		pasteTarget = await launchPasteTarget();
		await pasteTarget.activate();
	});
	test.afterEach(async () => {
		try {
			// IME をオフにし損ねても、貼り付け先は閉じる
			await turnImeOff().catch(() => {});
			await pasteTarget?.close();
		} finally {
			await suite.closeClient(client);
		}
	});

	test('Ctrl+J で一覧が出て絞り込みの欄にフォーカスがあり、名前のない定型文は本文で出る', async () => {
		await prepareDraft(client);
		const palette = await openPalette(client);
		// 末尾は「テキストを定型文に登録」
		assert.equal(palette.options.length, 3);
		assert.ok(palette.options[0].startsWith('かくにん'), JSON.stringify(palette.options));
		assert.equal(palette.options[1], 'git status');
		assert.ok(
			palette.options[2].startsWith('テキストを定型文に登録'),
			JSON.stringify(palette.options)
		);
	});

	test('変換中の Enter と Esc は変換の操作になり、確定してからの Enter でカーソルの位置に差し込み、Ctrl+Z で戻る', async () => {
		await prepareDraft(client);
		await openPalette(client);
		await turnImeOn();

		// 変換中の Esc は変換の取り消しで、一覧は閉じない
		await typeRomaji('kakuninn');
		await waitFor(
			() => readSnippetPalette(client),
			(palette) => palette.query === 'かくにん',
			{ label: '絞り込みの欄の変換中の文字' }
		);
		await sendKeySequence([[VK.ESCAPE]]);
		await expectPaletteStaysOpen(client, '変換中の Esc で一覧は閉じないはず');
		await expectDraftStaysVisible('変換中の Esc');

		// 変換中の Enter は変換の確定で、差し込まない
		await typeRomaji('kakuninn');
		await waitFor(
			() => readSnippetPalette(client),
			(palette) => palette.query === 'かくにん',
			{ label: '絞り込みの欄の変換中の文字 (2回目)' }
		);
		await sendKeySequence([[VK.ENTER]]);
		await expectPaletteStaysOpen(client, '変換中の Enter で一覧は閉じないはず');
		assert.equal((await readDraft(client)).value, 'あいう', '変換中の Enter で差し込まないはず');

		// 確定してからの Enter で、一覧を出したときのカーソルの位置に差し込む
		await turnImeOff();
		await sendKeySequence([[VK.ENTER]]);
		const inserted = `あい${BODY}う`;
		const draft = await waitFor(
			() => readDraft(client),
			(d) => d.value === inserted,
			{ label: 'カーソルの位置に差し込まれる' }
		);
		assert.equal((await readSnippetPalette(client)).open, false, '差し込んだら一覧は閉じるはず');
		assert.equal(draft.focused, true, '入力欄にフォーカスが戻るはず');
		assert.equal(draft.selectionStart, 2 + BODY.length, 'カーソルは差し込んだ本文の直後');

		await sendKeySequence([[VK.CONTROL, VK.Z]]);
		await waitFor(
			() => readDraft(client),
			(d) => d.value === 'あいう',
			{ label: 'Ctrl+Z で差し込む前に戻る' }
		);
	});

	test('末尾の「テキストを定型文に登録」を選ぶと、下書きはそのままで、設定に残り、次の一覧に出る', async () => {
		try {
			await prepareDraft(client);
			await openPalette(client);
			await sendKeySequence([[VK.DOWN], [VK.DOWN], [VK.ENTER]]);
			const { draft } = await waitFor(
				async () => ({ palette: await readSnippetPalette(client), draft: await readDraft(client) }),
				({ palette, draft }) => !palette.open && draft.focused,
				{ label: '一覧が閉じて入力欄にフォーカスがある' }
			);
			assert.equal(draft.value, 'あいう', '下書きは変わらないはず');
			assert.equal(draft.selectionStart, 2, 'カーソルは一覧を出したときの位置のまま');

			const settings = await invokeApp(client, 'get_settings');
			assert.deepEqual(settings.snippets, [...SNIPPETS, { name: '', body: 'あいう' }]);
			const palette = await openPalette(client);
			assert.equal(palette.options[2], 'あいう', JSON.stringify(palette.options));
		} finally {
			// 設定ファイルに書かれ、このファイルのほかのテスト (起動し直す) に残るので戻す
			await invokeApp(client, 'set_snippets', { snippets: SNIPPETS });
		}
	});

	test('Esc で一覧だけが閉じ、下書きは出たまま、カーソルは元の位置に戻る', async () => {
		await prepareDraft(client);
		await openPalette(client);
		await sendKeySequence([[VK.ESCAPE]]);
		await waitFor(
			() => readSnippetPalette(client),
			(palette) => !palette.open,
			{ label: 'Esc で一覧が閉じる' }
		);
		await expectDraftStaysVisible('一覧を閉じた Esc');
		const draft = await readDraft(client);
		assert.equal(draft.focused, true);
		assert.equal(draft.selectionStart, 2);
		assert.equal(draft.value, 'あいう');
	});

	test('一覧を出したままほかのアプリをクリックして隠し、出し直すと一覧は閉じて入力欄から始まる', async () => {
		await prepareDraft(client);
		await openPalette(client);
		await pasteTarget.activate();
		await waitDraftHidden('ほかのアプリをクリックした後の非表示');

		await showDraftAndWaitVisible('出し直し');
		await waitFor(
			async () => ({ palette: await readSnippetPalette(client), draft: await readDraft(client) }),
			({ palette, draft }) => !palette.open && draft.focused,
			{ label: '一覧が閉じて入力欄にフォーカスがある' }
		);
	});

	test('Ctrl+J で一覧が出るだけで、WebView2 のほかの画面は開かない', async () => {
		await prepareDraft(client);
		const draftHwnd = await getDraftWindowHandle();
		// WebView2 の中に出る画面 (ダウンロードの一覧など) はトップレベルのウィンドウを作らないことがあるので、子ウィンドウまで比べる
		const before = await listVisibleMawokTreeWindows({ includeChildren: true });

		await openPalette(client);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		assert.deepEqual(
			await listVisibleMawokTreeWindows({ includeChildren: true }),
			before,
			'ウィンドウも子ウィンドウも増えないはず'
		);
		assert.equal(await getForegroundWindowHandle(), draftHwnd, '下書きが前面のまま');
	});

	test('設定の「定型文」を開いたまま、下書きの選んだ範囲を名前を付けて登録すると、設定の末尾に行が出て、ほかの行を直しても消えない', async () => {
		try {
			await showDraftAndWaitVisible();
			// 設定を開いて「定型文」を出しておく。下書きは設定を開くと隠れる
			const draftHandle = await openSettingsFromDraft(client);
			const settingsHandle = await client.getWindowHandle();
			await client.$('button[role="tab"]*=定型文').click();
			const rowButtons = () =>
				client.execute(
					(toggle) =>
						[...document.querySelectorAll(`[role="tabpanel"]:not([hidden]) ${toggle}`)].map(
							(button) => button.textContent.trim()
						),
					ROW_TOGGLE
				);
			await waitFor(rowButtons, (rows) => rows.length === SNIPPETS.length, {
				label: '設定の定型文の行'
			});

			// 設定を開いたまま、ホットキーで下書きを出して登録する
			await showDraftAndWaitVisible('設定を開いたまま出す下書き');
			await waitForWindowCount(client, 2);
			await client.switchToWindow(draftHandle);
			await typeIntoDraft(client, 'おつかれさま');
			await setDraftCaret(client, 0, 'おつかれさま'.length);
			await openPalette(client);
			await client.keys('ねぎらい');
			const palette = await waitFor(
				() => readSnippetPalette(client),
				// 項目には、登録する本文の頭が添えてある
				(current) =>
					current.options.at(-1)?.startsWith('選んだ範囲を「ねぎらい」として定型文に登録'),
				{ label: '名前を付けて登録する項目' }
			);
			assert.equal(palette.options.length, 1, JSON.stringify(palette.options));
			await sendKeySequence([[VK.ENTER]]);
			await waitFor(
				() => readSnippetPalette(client),
				(current) => !current.open,
				{ label: '登録して一覧が閉じる' }
			);

			// 設定の画面の末尾に行が足される
			await client.switchToWindow(settingsHandle);
			const rows = await waitFor(rowButtons, (current) => current.length === SNIPPETS.length + 1, {
				label: '設定の定型文に足された行'
			});
			assert.match(rows.at(-1), /ねぎらい/);
			assert.match(rows.at(-1), /おつかれさま/);

			// ほかの行を開いて名前を1文字直しても、足した行は消えない (設定画面が古い並びで保存し直さない)
			const [firstRow] = await client.$$(`[role="tabpanel"]:not([hidden]) ${ROW_TOGGLE}`);
			await firstRow.click();
			const name = await client.$(
				'[role="tabpanel"]:not([hidden]) input[aria-label="定型文の名前"]'
			);
			await name.waitForDisplayed({ timeout: 5000 });
			await name.click();
			await client.keys(['End', 'X']);
			const settings = await waitFor(
				() => invokeApp(client, 'get_settings'),
				(current) => current.snippets[0]?.name === `${SNIPPETS[0].name}X`,
				{ label: '名前を直した定型文の保存' }
			);
			assert.deepEqual(settings.snippets.at(-1), { name: 'ねぎらい', body: 'おつかれさま' });
			assert.equal(settings.snippets.length, SNIPPETS.length + 1);
			assert.equal((await rowButtons()).length, SNIPPETS.length + 1, '足した行は画面にも残るはず');

			await client.keys(['Escape']);
			await waitForWindowCount(client, 1);
			await client.switchToWindow(draftHandle);
		} finally {
			// 途中で落ちて設定のウィンドウが閉じていても送れるよう、残っているウィンドウに切り替えてから戻す
			const [handle] = await client.getWindowHandles();
			await client.switchToWindow(handle);
			await invokeApp(client, 'set_snippets', { snippets: SNIPPETS });
		}
	});
});
