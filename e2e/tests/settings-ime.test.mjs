import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	selectCopyCategory,
	setJapanese,
	showDraftAndWaitVisible,
	waitDraftHidden,
	waitForWindowCount,
	waitSettingsWindow
} from '../lib/app.mjs';
import { SETTINGS_TITLE } from '../lib/app-conf.mjs';
import {
	findVisibleMawokWindow,
	getForegroundWindowHandle,
	isDraftWindowVisible
} from '../lib/os.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { convertComposition, NIHON_READING, startComposingNihon, turnImeOff } from '../lib/ime.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';

// 設定ウィンドウで日本語を変換している間のキー。
// 置き換え辞書の入力欄で、変換中の Esc はウィンドウを閉じず、変換中の Ctrl+, では何も起きないことを見る。
// 下書き側の 1.・2.・5. は draft-ime.test.mjs にある。
//
// WebDriver から送る文字は IME を通らないので、SendInput で本物の Microsoft IME をオンにしてローマ字を打つ。
// Microsoft IME が入っている環境が前提

const suite = createSuite();
const FROM_INPUT = 'input[aria-label="置き換える前の文字列"]';

test.describe('設定ウィンドウの IME', () => {
	let testConfig;
	let client;
	let draftHandle;
	let settingsHwnd;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			language: 'ja',
			replacements: []
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
		[draftHandle] = await client.getWindowHandles();
	});
	test.afterEach(async () => {
		try {
			// 前面のウィンドウの IME をオンのまま残さない
			await turnImeOff().catch(() => {});
		} finally {
			await suite.closeClient(client);
		}
	});

	/** 設定ウィンドウが出たままかどうか */
	const isSettingsOpen = async () => (await findVisibleMawokWindow(SETTINGS_TITLE)) !== null;

	/** 下書きから Ctrl+, で設定を開き、置き換え辞書の「置き換える前の文字列」の欄を1つ増やして返す */
	async function openReplacementInput() {
		await showDraftAndWaitVisible();
		await sendKeySequence([[VK.CONTROL, VK.COMMA]]);
		await waitDraftHidden('下書きウィンドウの非表示 (設定を開いた直後)');
		const settings = await waitSettingsWindow(client, draftHandle);
		settingsHwnd = settings.settingsHwnd;
		await client.switchToWindow(settings.settingsHandle);

		// ほかの分類は hidden で DOM に残るので、分類を選べたことを見届けてから押す
		const addButton = await selectCopyCategory(client);
		const before = await client.$$(FROM_INPUT).length;
		await addButton.click();
		await waitFor(
			() => client.$$(FROM_INPUT).length,
			(count) => count === before + 1,
			{ label: '置き換え辞書の行が増える' }
		);
		const inputs = await client.$$(FROM_INPUT);
		return inputs[inputs.length - 1];
	}

	/** 欄を本物のクリックでフォーカスし、変換中にする */
	const startComposing = (input) =>
		startComposingNihon(client, settingsHwnd, input, () => input.getValue());

	/** 設定ウィンドウが出たままであることを、しばらく見続ける */
	const expectSettingsStaysOpen = (label, duration) =>
		expectStays(isSettingsOpen, true, { label: `${label}: 設定ウィンドウの表示`, duration });

	test('置き換え辞書の欄で、変換中の Esc は変換の取り消しになり、設定ウィンドウは閉じない', async () => {
		const input = await openReplacementInput();
		await startComposing(input);
		await convertComposition(() => input.getValue());

		// 変換した後の1回目は読みに戻り、2回目で変換を取り消す。どちらでもウィンドウは閉じない
		await sendKeySequence([[VK.ESCAPE]]);
		await waitFor(
			() => input.getValue(),
			(value) => value.startsWith(NIHON_READING),
			{ label: '1回目の Esc で読みに戻る' }
		);
		await expectSettingsStaysOpen('変換中の1回目の Esc');

		await sendKeySequence([[VK.ESCAPE]]);
		await waitFor(
			() => input.getValue(),
			(value) => value === '',
			{ label: '2回目の Esc で変換を取り消す' }
		);
		await expectSettingsStaysOpen('変換中の2回目の Esc');

		// 変換していなければ Esc で閉じる (Esc そのものが効かなくなっていないことを見る)
		await turnImeOff();
		await sendKeySequence([[VK.ESCAPE]]);
		await waitForWindowCount(client, 1);
	});

	test('置き換え辞書の欄で、変換中の Ctrl+, では何も起きない', async () => {
		const input = await openReplacementInput();
		await startComposing(input);
		const composing = await convertComposition(() => input.getValue());

		await sendKeySequence([[VK.CONTROL, VK.COMMA]]);

		// ウィンドウは増えも減りもせず、設定が前面のまま、変換中の文字も残る
		await expectSettingsStaysOpen('変換中の Ctrl+,');
		assert.equal(
			(await client.getWindowHandles()).length,
			2,
			'設定ウィンドウが開き直されたり増えたりしないはず'
		);
		assert.equal(
			await getForegroundWindowHandle(),
			settingsHwnd,
			'設定ウィンドウが前面のままのはず'
		);
		assert.equal(await input.getValue(), composing, '変換中の文字がそのまま残るはず');
		assert.equal(await isDraftWindowVisible(), false, '下書きが出てこないはず');
	});
});
