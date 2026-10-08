import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	expectDraftStaysVisible,
	readSnippetPalette,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft
} from '../lib/app.mjs';
import { getDraftWindowHandle } from '../lib/os.mjs';
import { clickClientPoint, sendKeySequence, VK } from '../lib/input.mjs';
import { readWindow } from '../lib/window.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import { waitFor } from '../lib/wait.mjs';

// 読み込み直すキー。WebView2 は F5・Ctrl+R などで画面を読み込み直し、
// 書きかけが消えるので、下書きウィンドウのどこで押しても止まることを、本物のキー入力で見る。
// 読み込み直したかは、押す前に画面に置いた印が消えるかで見る (読み込み直すと window が作り直される)

const suite = createSuite();
const TEXT = '書きかけの下書き';
const RELOAD_KEYS = [
	['F5', [VK.F5]],
	['Ctrl+R', [VK.CONTROL, VK.R]],
	['Ctrl+Shift+R', [VK.CONTROL, VK.SHIFT, VK.R]],
	['Shift+F5', [VK.SHIFT, VK.F5]],
	['Ctrl+F5', [VK.CONTROL, VK.F5]]
];

/** 読み込み直していなければ残る印を置く */
const mark = (client) => client.execute(() => (window.__e2eNotReloaded = true));

async function expectNotReloaded(client, label) {
	// 読み込み直しが始まると印は消える。始まるまでの間を見逃さないよう、しばらく待ってから見る
	await expectDraftStaysVisible(label, 700);
	const state = await client.execute(() => ({
		marked: window.__e2eNotReloaded === true,
		value: document.querySelector('textarea')?.value ?? null
	}));
	assert.deepEqual(
		state,
		{ marked: true, value: TEXT },
		`${label}: 読み込み直さず、書きかけが残るはず`
	);
}

test.describe('読み込み直すキー', () => {
	let testConfig;
	let client;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			hideTextWindowOnBlur: false,
			snippets: [{ name: 'かくにん', body: '一つずつ質問してください。' }]
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
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, TEXT);
	});
	test.afterEach(async () => {
		await suite.closeClient(client);
	});

	test('入力欄にフォーカスがあるとき', async () => {
		for (const [name, combo] of RELOAD_KEYS) {
			await mark(client);
			await sendKeySequence([combo]);
			await expectNotReloaded(client, name);
		}
	});

	test('余白を押して入力欄からフォーカスを外したとき', async () => {
		const hwnd = await getDraftWindowHandle();
		const { scale } = await readWindow(hwnd);
		// 下書きの左上の余白 (main の p-2 の中) を本物のマウスで押す
		await clickClientPoint(hwnd, 3 * scale, 3 * scale);
		const focused = await client.execute(() => document.activeElement?.tagName);
		assert.notEqual(focused, 'TEXTAREA', '余白を押すと入力欄からフォーカスが外れるはず');
		for (const [name, combo] of RELOAD_KEYS) {
			await mark(client);
			await sendKeySequence([combo]);
			await expectNotReloaded(client, name);
		}
	});

	test('定型文の一覧を開いているとき', async () => {
		await sendKeySequence([[VK.CONTROL, VK.J]]);
		await waitFor(
			() => readSnippetPalette(client),
			(palette) => palette.open && palette.inputFocused,
			{ label: '定型文の一覧が出る' }
		);
		for (const [name, combo] of RELOAD_KEYS) {
			await mark(client);
			await sendKeySequence([combo]);
			await expectNotReloaded(client, name);
			assert.equal((await readSnippetPalette(client)).open, true, `${name}: 一覧は出たまま`);
		}
	});
});
