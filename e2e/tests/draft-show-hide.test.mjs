import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	clickElement,
	expectDraftStaysVisible,
	hideDraft,
	invokeApp,
	readDraft,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitDraftHidden
} from '../lib/app.mjs';
import {
	getClipboard,
	getDraftWindowHandle,
	getForegroundWindowHandle,
	setClipboard
} from '../lib/os.mjs';
import { clickCloseButton, clickTitleBar, sendKeySequence, VK } from '../lib/input.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import { launchPasteTarget } from '../lib/paste-target.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';

// 下書きの出し方・隠し方 (何も書かずに隠すときを含む)。
// フォーカスとクリックは WebDriver ではなく本物の入力で起こし、前面のウィンドウは Win32 で見る
// (WebDriver の操作は OS から見たフォーカスを動かさないので、隠す判定を通らない)

const suite = createSuite();
const SENTINEL = 'e2e-sentinel-before';

test.describe('下書きを出す・隠す', () => {
	let testConfig;
	let client;
	let pasteTarget;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			hideTextWindowOnBlur: true,
			// ほかのウィンドウをクリックしても、下書きの入力欄やタイトルバーが覆われないよう最前面にする
			textWindowAlwaysOnTop: true,
			trimTrailingWhitespace: true,
			replacements: [],
			punctuationStyle: 'keep'
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
			await pasteTarget?.close();
		} finally {
			await suite.closeClient(client);
		}
	});

	test('ホットキーで出すと下書きが前面になり、入力欄にカーソルがあってそのまま打てる', async () => {
		await showDraftAndWaitVisible();
		const draftHwnd = await getDraftWindowHandle();
		await waitFor(getForegroundWindowHandle, (handle) => handle === draftHwnd, {
			label: '下書きが前面になる'
		});
		await waitFor(
			() => readDraft(client),
			(draft) => draft.focused,
			{ label: '入力欄のフォーカス' }
		);
		// WebView の中のフォーカスだけでなく、本物のキー入力が入力欄に届くことまで見る
		await sendKeySequence([[VK.X]]);
		await waitFor(
			() => readDraft(client),
			(draft) => draft.value === 'x',
			{ label: '打った文字が入力欄に入る' }
		);
	});

	test('コピーした後に出し直すと、入力欄が空から始まる', async () => {
		const text = `e2e empty after copy ${Date.now()}`;
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, text);
		assert.equal((await readDraft(client)).value, text);
		await hideDraft(client);
		await waitDraftHidden('Ctrl+Enter 後の非表示');

		await showDraftAndWaitVisible('出し直し');
		await waitFor(
			() => readDraft(client),
			(draft) => draft.value === '' && draft.focused,
			{ label: '出し直した入力欄が空でフォーカスがある' }
		);
	});

	test('閉じるボタンで隠しても、クリップボードは変わらず、出し直すと書きかけが残る', async () => {
		await setClipboard(SENTINEL);
		const text = `e2e close button ${Date.now()}`;
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, text);

		await clickCloseButton(await getDraftWindowHandle());
		await waitDraftHidden('閉じるボタンの後の非表示');
		await pasteTarget.waitForeground();
		assert.equal(await getClipboard(), SENTINEL);

		await showDraftAndWaitVisible('出し直し');
		assert.equal((await readDraft(client)).value, text, '書きかけが残っているはず');
	});

	test('ほかのアプリをクリックすると隠れ、クリックしたアプリが前面のまま、クリップボードは変わらず書きかけが残る', async () => {
		await setClipboard(SENTINEL);
		const text = `e2e blur ${Date.now()}`;
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, text);

		await pasteTarget.activate();
		await waitDraftHidden('ほかのアプリをクリックした後の非表示');
		// 隠したときに戻り先へフォーカスを戻すと、クリックしたアプリから前面を奪うので、しばらく見る
		await expectStays(getForegroundWindowHandle, pasteTarget.hwnd, {
			label: 'クリックしたアプリが前面のまま',
			duration: 500
		});
		assert.equal(await getClipboard(), SENTINEL);

		await showDraftAndWaitVisible('出し直し');
		assert.equal((await readDraft(client)).value, text, '書きかけが残っているはず');
	});

	test('「ほかのアプリに移ったら下書きを隠す」をオフにすると、ほかのアプリをクリックしても隠れない', async () => {
		await invokeApp(client, 'set_hide_draft_on_blur', { enabled: false });
		try {
			await showDraftAndWaitVisible();
			await typeIntoDraft(client, `e2e blur off ${Date.now()}`);
			await pasteTarget.activate();
			await expectDraftStaysVisible('ほかのアプリをクリックした後');
		} finally {
			// 設定ファイルに書かれ、このファイルのほかのテスト (起動し直す) に残るので戻す
			await invokeApp(client, 'set_hide_draft_on_blur', { enabled: true });
		}
	});

	test('入力欄の中やタイトルバーをクリックしても隠れない', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, `e2e click inside ${Date.now()}`);
		const draftHwnd = await getDraftWindowHandle();

		await clickElement(client, draftHwnd, await client.$('textarea'));
		await expectDraftStaysVisible('入力欄をクリックした後');
		await clickTitleBar(draftHwnd);
		await expectDraftStaysVisible('タイトルバーをクリックした後');
		assert.equal(await getForegroundWindowHandle(), draftHwnd, '下書きが前面のまま');
	});

	for (const { name, text } of [
		{ name: '何も書かずに', text: '' },
		// 末尾の全角スペースも空白として扱う
		{ name: '空白と改行だけを書いて', text: ' \n\n　' }
	]) {
		test(`${name} Ctrl+Enter で隠しても、クリップボードは変わらない`, async () => {
			await setClipboard(SENTINEL);
			await showDraftAndWaitVisible();
			if (text) await typeIntoDraft(client, text);
			await hideDraft(client);
			await waitDraftHidden('Ctrl+Enter 後の非表示');
			// クリップボードへの書き込みは隠す前に済むので、隠れた後に少し待っても変わらないことを見る
			await expectStays(getClipboard, SENTINEL, {
				label: 'Ctrl+Enter 後のクリップボード',
				duration: 500
			});
		});
	}
});
