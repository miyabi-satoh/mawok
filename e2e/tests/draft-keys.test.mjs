import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	expectDraftStaysVisible,
	invokeApp,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitDraftHidden
} from '../lib/app.mjs';
import { getClipboard, setClipboard } from '../lib/os.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { beginTestConfig, tryReadConfig } from '../lib/config.mjs';
import { launchPasteTarget } from '../lib/paste-target.mjs';
import { waitFor } from '../lib/wait.mjs';

// 下書きウィンドウのキーの変更。割り当ては設定画面と同じコマンドで変え、
// 押すキーは本物のキー入力 (SendInput) で送る。設定の変更が settings-changed で下書きウィンドウに届き、
// 押したキーの照らし合わせが変わるところを見る。重なったキーを断るところは部品テストと cargo test で見ている

const suite = createSuite();
const SENTINEL = 'e2e-sentinel-before';
// 既定のキーと重ならない、使っていないキーにする
const OTHER_COPY_KEY = 'CommandOrControl+KeyM';

test.describe('下書きウィンドウのキーの変更', () => {
	let testConfig;
	let client;
	let pasteTarget;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			// 貼り付け先を前面にしたまま下書きを出すので、ほかのアプリへ移ったときに隠れる設定に左右されないようにする
			hideTextWindowOnBlur: false
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

	test('コピーして隠すキーを変えると、そのキーでコピーして隠れ、元のキーでは隠れない。既定に戻すと元のキーで隠れる', async () => {
		try {
			await invokeApp(client, 'set_draft_key', { action: 'copy', key: OTHER_COPY_KEY });
			await waitFor(tryReadConfig, (config) => config?.textWindowKeys?.copy === OTHER_COPY_KEY, {
				label: 'config.toml のコピーのキーが変わる'
			});

			await setClipboard(SENTINEL);
			const text = `e2e draft key ${Date.now()}`;
			await showDraftAndWaitVisible();
			await typeIntoDraft(client, text);

			await sendKeySequence([[VK.CONTROL, VK.ENTER]]);
			// 元のキーでは隠れないはず
			await expectDraftStaysVisible('元のキーを押した後', 1000);
			assert.equal(await getClipboard(), SENTINEL, '元のキーではコピーしないはず');

			await sendKeySequence([[VK.CONTROL, VK.M]]);
			await waitDraftHidden('変えたキーで隠れる');
			await waitFor(getClipboard, (value) => value === text, { label: 'クリップボード' });

			await invokeApp(client, 'reset_draft_key', { action: 'copy' });
			await waitFor(
				tryReadConfig,
				(config) => config?.textWindowKeys?.copy === 'CommandOrControl+Enter',
				{ label: 'config.toml のコピーのキーが既定に戻る' }
			);
			const again = `e2e draft key again ${Date.now()}`;
			await showDraftAndWaitVisible('下書きウィンドウの表示 (既定に戻した後)');
			await typeIntoDraft(client, again);
			await sendKeySequence([[VK.CONTROL, VK.ENTER]]);
			await waitDraftHidden('既定のキーで隠れる');
			await waitFor(getClipboard, (value) => value === again, {
				label: 'クリップボード (既定に戻した後)'
			});
		} finally {
			await invokeApp(client, 'reset_draft_key', { action: 'copy' }).catch(() => {});
		}
	});
});
