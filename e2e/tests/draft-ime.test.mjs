import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	expectDraftStaysVisible,
	readDraft,
	sendHotkeyAsKeyInput,
	setJapanese,
	waitDraftHidden
} from '../lib/app.mjs';
import {
	getClipboard,
	getDraftWindowHandle,
	getForegroundWindowHandle,
	setClipboard
} from '../lib/os.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import {
	convertComposition,
	NIHON_READING,
	startComposingInDraft,
	turnImeOff
} from '../lib/ime.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import { launchPasteTarget } from '../lib/paste-target.mjs';
import { waitFor } from '../lib/wait.mjs';

// 下書きで日本語を変換している間のキー。
// WebDriver から送る文字は IME を通らないので、SendInput で本物の Microsoft IME をオンにしてローマ字を打つ

const suite = createSuite();
const SENTINEL = 'e2e-sentinel-before';

/** Space で変換し、読みから変わるまで待つ。変換した後の入力欄の中身を返す */
async function convert(client) {
	return convertComposition(async () => (await readDraft(client)).value);
}

test.describe('下書きの IME', () => {
	let testConfig;
	let client;
	let pasteTarget;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			hideTextWindowOnBlur: true,
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
			// 前面にあるウィンドウの IME をオンのまま残さない。オフにし損ねても、貼り付け先は閉じる
			await turnImeOff().catch(() => {});
			await pasteTarget?.close();
		} finally {
			await suite.closeClient(client);
		}
	});

	test('変換中の Esc は変換の取り消しになり、下書きは隠れない', async () => {
		await startComposingInDraft(client);
		await convert(client);

		// 変換した後の1回目は読みに戻り、2回目で変換を取り消す
		await sendKeySequence([[VK.ESCAPE]]);
		await waitFor(
			() => readDraft(client),
			(draft) => draft.value.startsWith(NIHON_READING),
			{ label: '1回目の Esc で読みに戻る' }
		);
		await expectDraftStaysVisible('変換中の1回目の Esc');
		await sendKeySequence([[VK.ESCAPE]]);
		await waitFor(
			() => readDraft(client),
			(draft) => draft.value === '',
			{ label: '2回目の Esc で変換を取り消す' }
		);
		await expectDraftStaysVisible('変換中の2回目の Esc');

		// 変換していなければ、Esc で隠れる (Esc そのものが効かなくなっていないことを見る)
		await sendKeySequence([[VK.ESCAPE]]);
		await waitDraftHidden('変換していない Esc で隠れる');
	});

	test('変換中にホットキーで隠すと、未確定の文字も含めてコピーされる', async () => {
		await setClipboard(SENTINEL);
		await startComposingInDraft(client);
		const composing = await convert(client);

		await sendHotkeyAsKeyInput();
		await waitDraftHidden('変換中のホットキーで隠れる');
		const clipboard = await waitFor(getClipboard, (value) => value === composing, {
			label: '未確定の文字を含めたクリップボード'
		});
		assert.equal(clipboard, composing);
	});

	test('変換中の Ctrl+Enter は変換の操作になり、下書きは隠れずコピーもしない', async () => {
		await setClipboard(SENTINEL);
		await startComposingInDraft(client);
		await convert(client);

		await sendKeySequence([[VK.CONTROL, VK.ENTER]]);
		await expectDraftStaysVisible('変換中の Ctrl+Enter');
		assert.equal(await getClipboard(), SENTINEL);
	});

	test('変換候補の一覧を出しても、下書きは隠れない', async () => {
		await startComposingInDraft(client);
		await convert(client);
		// 変換した後にもう一度 Space を押すと、変換候補の一覧 (IME のウィンドウ) が出る
		await sendKeySequence([[VK.SPACE]]);
		await expectDraftStaysVisible('変換候補の一覧を出した後', 1500);
		assert.equal(await getForegroundWindowHandle(), await getDraftWindowHandle());
	});
});
