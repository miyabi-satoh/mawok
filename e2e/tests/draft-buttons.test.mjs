import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	clickElement,
	closeDraftSettings,
	copyDraft,
	invokeApp,
	listDraftButtons,
	readDraft,
	readSnippetPalette,
	setDraftCaret,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitDraftHidden,
	waitForWindowCount
} from '../lib/app.mjs';
import { getClipboard, getDraftWindowHandle, setClipboard } from '../lib/os.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { convertComposition, startComposingInDraft, turnImeOff } from '../lib/ime.mjs';
import { beginTestConfig, tryReadConfig } from '../lib/config.mjs';
import { expectPasted, launchPasteTarget } from '../lib/paste-target.mjs';
import { waitFor } from '../lib/wait.mjs';

// 下書きのボタン。押したときの働きは部品テストで見ているので、ここでは実際の WebView での
// フォーカスと IME を見る。ボタンは tabindex=-1 でマウスで使うものなので、本物のクリックで押す
// (WebDriver の click はフォーカスの移り方が本物と違い、変換中の確定を起こさない)

const suite = createSuite();
const SENTINEL = 'e2e-sentinel-before';
const SNIPPETS = [{ name: '定型', body: 'ABC' }];

const byText = (buttons, prefix) => buttons.find((button) => button.text.startsWith(prefix));

test.describe('下書きのボタン', () => {
	let testConfig;
	let client;
	let pasteTarget;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			showTextWindowButtons: true,
			textHistorySize: 50,
			hideTextWindowOnBlur: true,
			textWindowAlwaysOnTop: true,
			trimTrailingWhitespace: true,
			replacements: [],
			punctuationStyle: 'keep',
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

	/** ボタンを本物のクリックで押す。`selector` は WebdriverIO のセレクター */
	async function clickButton(selector) {
		await clickElement(client, await getDraftWindowHandle(), await client.$(selector));
	}

	test('履歴がないうちは、入力欄の下に設定・定型文・コピーの列があり、上に列はない', async () => {
		await showDraftAndWaitVisible();
		const buttons = await listDraftButtons(client);
		const below = buttons.filter((button) => button.position === 'below');
		assert.ok(
			below.some((button) => button.label === '設定'),
			JSON.stringify(buttons)
		);
		assert.ok(byText(below, '定型文'), JSON.stringify(buttons));
		assert.ok(byText(below, 'コピー'), JSON.stringify(buttons));
		assert.equal(
			buttons.filter((button) => button.position === 'above').length,
			0,
			JSON.stringify(buttons)
		);
	});

	test('「コピー」を押すと隠れてフォーカスが戻り、貼り付け先に届き、出し直すと上に前・次の列が出る', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'git status');
		await clickButton('button*=コピー');
		await waitDraftHidden('コピーのボタンの後の非表示');
		assert.equal(await expectPasted(pasteTarget, 'git status'), 'git status');

		await showDraftAndWaitVisible('出し直し');
		await waitFor(
			() => listDraftButtons(client),
			(buttons) => {
				const above = buttons.filter((button) => button.position === 'above');
				return byText(above, '前') !== undefined && byText(above, '次') !== undefined;
			},
			{ label: '入力欄の上に前・次の列が出る' }
		);
	});

	test('変換中に「コピー」を押すと、未確定の文字も含めてコピーされる', async () => {
		await setClipboard(SENTINEL);
		await startComposingInDraft(client);
		const composing = await convertComposition(async () => (await readDraft(client)).value);

		await clickButton('button*=コピー');
		await waitDraftHidden('変換中にコピーのボタンを押した後の非表示');
		const clipboard = await waitFor(getClipboard, (value) => value === composing, {
			label: '未確定の文字を含めたクリップボード'
		});
		assert.equal(clipboard, composing);
	});

	test('「前」を押すと履歴が出て、入力欄にカーソルがあり、そのまま打てる', async () => {
		await copyDraft(client, 'git status');
		await showDraftAndWaitVisible();
		await waitFor(
			() => listDraftButtons(client),
			(buttons) => byText(buttons, '前') !== undefined,
			{ label: '前のボタン' }
		);
		await clickButton('button*=前');
		await waitFor(
			() => readDraft(client),
			(draft) => draft.value === 'git status' && draft.focused,
			{ label: '前で履歴が出て、入力欄にフォーカスがある' }
		);
		// 古い方へ移ると、カーソルは先頭に置かれる
		await sendKeySequence([[VK.X]]);
		await waitFor(
			() => readDraft(client),
			(draft) => draft.value === 'xgit status',
			{ label: 'そのまま打った文字が入る' }
		);
	});

	test('「定型文」を押すと一覧が出て、選んだ定型文がカーソルの位置に差し込まれる', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'あいう');
		await setDraftCaret(client, 2);
		await clickButton('button*=定型文');
		await waitFor(
			() => readSnippetPalette(client),
			// 定型文1件と、末尾の「テキストを定型文に登録」
			(palette) => palette.open && palette.options.length === 2,
			{ label: '定型文の一覧' }
		);
		await clickElement(client, await getDraftWindowHandle(), await client.$('[role="option"]'));
		await waitFor(
			() => readDraft(client),
			(draft) => draft.value === 'あいABCう',
			{ label: 'カーソルの位置に差し込まれる' }
		);
	});

	test('定型文がないときに「定型文」を押すと、登録を促す文が出る', async () => {
		await invokeApp(client, 'set_snippets', { snippets: [] });
		try {
			await showDraftAndWaitVisible();
			await clickButton('button*=定型文');
			await waitFor(
				() => readSnippetPalette(client),
				(palette) => palette.open && (palette.status ?? '').startsWith('定型文はまだありません'),
				{ label: '登録を促す文' }
			);
		} finally {
			// 設定ファイルに書かれ、このファイルのほかのテスト (起動し直す) に残るので戻す
			await invokeApp(client, 'set_snippets', { snippets: SNIPPETS });
		}
	});

	test('歯車で設定が開き、「下書きにボタンを表示」をオフにすると、出し直された下書きに上下どちらの列もない', async () => {
		// 上の列 (前・次) も出る状態にしてから始める
		await copyDraft(client, 'git status');
		await showDraftAndWaitVisible();
		const [draftHandle] = await client.getWindowHandles();
		try {
			await clickButton('button[aria-label="設定"]');
			await waitDraftHidden('設定を開いたときの非表示');
			const handles = await waitForWindowCount(client, 2);
			await client.switchToWindow(handles.find((handle) => handle !== draftHandle));

			const toggle = await client.$('#show-draft-buttons');
			await toggle.waitForDisplayed({ timeout: 5000 });
			await toggle.click();
			await waitFor(tryReadConfig, (config) => config?.showTextWindowButtons === false, {
				label: 'config.toml の showTextWindowButtons'
			});

			// ボタンの一覧は隠れていても読めるので、出し直されたことをネイティブウィンドウで見てから読む
			await closeDraftSettings(client, draftHandle);
			await waitFor(
				() => listDraftButtons(client),
				(buttons) => buttons.length === 0,
				{ label: '出し直された下書きにボタンがない' }
			);
		} finally {
			await client.switchToWindow(draftHandle).catch(() => {});
			await invokeApp(client, 'set_show_draft_buttons', { enabled: true });
		}
	});
});
