import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import { expectDraftStaysHidden, readDraft, waitDraftVisible } from '../lib/app.mjs';
import { getDraftWindowHandle, getForegroundWindowHandle } from '../lib/os.mjs';
import { beginMissingConfig, configExists } from '../lib/config.mjs';
import { waitFor } from '../lib/wait.mjs';

// 初めての起動。config.toml がない状態で起動すると下書きが出てフォーカスが入り、
// 起動したときに設定ファイルができるので、2回目の起動では出ない。
// config.toml がない起動は既定の設定 (ログイン時の起動がオン) で作り直すので、ログイン時の起動の登録も
// 書き換える (控えて書き戻すのは、`just e2e` では run.mjs が全体の前後で1度、直接回すときは setup.mjs の createSuite がファイルごとに行う)

const suite = createSuite();

test.describe('初めての起動', () => {
	let missingConfig;

	test.before(async () => {
		await suite.before();
		missingConfig = await beginMissingConfig();
	});
	test.after(async () => {
		try {
			await missingConfig?.restore();
		} finally {
			// ログイン時の起動の登録は、直接回すときは suite.after が書き戻す (`just e2e` では run.mjs が書き戻す)
			await suite.after();
		}
	});

	test('設定ファイルがないと下書きが出てフォーカスが入り、もう一度起動すると出ない', async () => {
		assert.equal(await configExists(), false, '設定ファイルがない状態から始める');

		// 画面の読み込みを待つ前から、出てくるのを見る
		let client = await suite.newClient({ waitForPage: false });
		try {
			await waitDraftVisible('初めての起動で下書きが出る', { timeout: 10_000 });
			const draftHwnd = await getDraftWindowHandle();
			await waitFor(getForegroundWindowHandle, (handle) => handle === draftHwnd, {
				label: '下書きが前面になる'
			});
			await waitFor(
				() => readDraft(client),
				(draft) => draft.focused,
				{ label: '入力欄のフォーカス' }
			);
			const placeholder = await client.$('textarea').getAttribute('placeholder');
			assert.ok(placeholder, '入力欄の案内が出ているはず');
			assert.equal(await configExists(), true, '起動したときに設定ファイルができるはず');
		} finally {
			await suite.closeClient(client);
		}

		client = await suite.newClient();
		try {
			// 出すなら起動の直後なので、画面の読み込みが終わってからしばらく出ないことを見る
			await expectDraftStaysHidden('2回目の起動');
		} finally {
			await suite.closeClient(client);
		}
	});
});
