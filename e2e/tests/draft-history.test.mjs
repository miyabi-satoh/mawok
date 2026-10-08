import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	copyDraft,
	invokeApp,
	listDraftButtons,
	readDraft,
	setDraftCaret,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft
} from '../lib/app.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { startComposingInDraft, turnImeOff } from '../lib/ime.mjs';
import { beginTestConfig, clearHistory, historyExists } from '../lib/config.mjs';
import { launchPasteTarget } from '../lib/paste-target.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';

// 下書きの履歴。↑↓ は WebDriver ではなく本物のキー入力で送る
// (IME の変換中の ↑↓ を同じ送り方で見るため)

const suite = createSuite();
const DEFAULT_HISTORY_SIZE = 50;

/** ↑↓ を送った後、入力欄の中身を読むまでの待ち */
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

/** ↑ を送った後、入力欄が空のまま (履歴が出ない) であることを見続ける */
const expectDraftStaysEmpty = (client, label) =>
	expectStays(async () => (await readDraft(client)).value, '', { label, duration: 700 });

test.describe('下書きの履歴', () => {
	let testConfig;
	let client;
	let pasteTarget;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			textHistorySize: DEFAULT_HISTORY_SIZE,
			// 件数を 0 にしたときに前・次の列が出ないことを見るので、ボタンは出す
			showTextWindowButtons: true,
			hideTextWindowOnBlur: true,
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
		await clearHistory();
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

	test('先頭の ↑ で古い履歴を出し、末尾の ↓ で新しい方と書きかけに戻る', async () => {
		await copyDraft(client, 'git status');
		await copyDraft(client, 'git diff');
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, '書きかけ');
		await setDraftCaret(client, 0);

		for (const [key, expected] of [
			[VK.UP, 'git diff'],
			[VK.UP, 'git status'],
			[VK.DOWN, 'git status'],
			[VK.DOWN, 'git diff'],
			[VK.DOWN, '書きかけ']
		]) {
			await sendKeySequence([[key]]);
			await waitFor(
				() => readDraft(client),
				(draft) => draft.value === expected,
				{ label: `${key === VK.UP ? '↑' : '↓'} で「${expected}」` }
			);
		}
	});

	test('1行目の途中の ↑ は先頭へ移り、もう一度で履歴を出す', async () => {
		await copyDraft(client, 'git status');
		await showDraftAndWaitVisible();
		const text = '1行目の途中';
		await typeIntoDraft(client, text);
		await setDraftCaret(client, 3);

		await sendKeySequence([[VK.UP]]);
		let draft = await waitFor(
			() => readDraft(client),
			(d) => d.value === text && d.selectionStart === 0,
			{ label: '1行目途中の↑で先頭へ移る' }
		);
		assert.equal(draft.value, text);
		await sendKeySequence([[VK.UP]]);
		await waitFor(
			() => readDraft(client),
			(d) => d.value === 'git status',
			{ label: '先頭からもう一度↑で履歴を出す' }
		);
	});

	test('最終行の途中の ↓ は末尾へ移り、もう一度で新しい履歴へ戻る', async () => {
		await copyDraft(client, 'git status');
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, '書きかけ');
		await setDraftCaret(client, 0);
		await sendKeySequence([[VK.UP]]);
		const shown = await waitFor(
			() => readDraft(client),
			(d) => d.value === 'git status',
			{
				label: '↑で履歴を出す'
			}
		);
		// 末尾の1文字前 (最終行の途中) に置く
		await setDraftCaret(client, shown.value.length - 1);

		await sendKeySequence([[VK.DOWN]]);
		await waitFor(
			() => readDraft(client),
			(d) => d.value === 'git status' && d.selectionStart === d.value.length,
			{ label: '最終行途中の↓で末尾へ移る' }
		);
		await sendKeySequence([[VK.DOWN]]);
		await waitFor(
			() => readDraft(client),
			(d) => d.value === '書きかけ',
			{ label: '末尾からもう一度↓で書きかけへ戻る' }
		);
	});

	test('空の入力欄では、上キー1回で履歴を出す', async () => {
		await copyDraft(client, 'git status');
		await showDraftAndWaitVisible();
		await sendKeySequence([[VK.UP]]);
		await waitFor(
			() => readDraft(client),
			(d) => d.value === 'git status',
			{
				label: '空欄の↑で履歴を出す'
			}
		);
	});

	test('2行目にカーソルがあるときの ↑ は行を移るだけで、履歴を出さない', async () => {
		await copyDraft(client, 'git status');
		await showDraftAndWaitVisible();
		const text = '1行目\n2行目';
		await typeIntoDraft(client, text);
		assert.equal(
			(await readDraft(client)).selectionStart,
			text.length,
			'カーソルは2行目の末尾から'
		);

		await sendKeySequence([[VK.UP]]);
		const draft = await waitFor(
			() => readDraft(client),
			(d) => d.selectionStart <= text.indexOf('\n'),
			{ label: '↑ でカーソルが1行目へ移る' }
		);
		assert.equal(draft.value, text, '履歴は出ないはず');
	});

	test('前の履歴のキー (Ctrl+Alt+↑) は、2行目にカーソルがあっても前の履歴を出し、Ctrl+Alt+↓ で書きかけに戻る', async () => {
		await copyDraft(client, 'git status');
		await showDraftAndWaitVisible();
		const text = '1行目\n2行目';
		await typeIntoDraft(client, text);

		await sendKeySequence([[VK.CONTROL, VK.ALT, VK.UP]]);
		await waitFor(
			() => readDraft(client),
			(d) => d.value === 'git status',
			{ label: 'Ctrl+Alt+↑ で前の履歴が出る' }
		);
		await sendKeySequence([[VK.CONTROL, VK.ALT, VK.DOWN]]);
		await waitFor(
			() => readDraft(client),
			(d) => d.value === text,
			{ label: 'Ctrl+Alt+↓ で書きかけに戻る' }
		);
	});

	test('折り返した1行でも、見た目の2行目にカーソルがあるときの ↑ は行を移るだけで、履歴を出さない', async () => {
		await copyDraft(client, 'git status');
		await showDraftAndWaitVisible();
		// 改行はないが、下書きウィンドウの幅で折り返して見た目は複数行になる
		const text = 'あ'.repeat(200);
		await typeIntoDraft(client, text);
		assert.equal(
			(await readDraft(client)).selectionStart,
			text.length,
			'カーソルは末尾 (見た目の最終行) から'
		);

		await sendKeySequence([[VK.UP]]);
		const draft = await waitFor(
			() => readDraft(client),
			(d) => d.selectionStart < text.length,
			{ label: '↑ でカーソルが上の行へ移る' }
		);
		assert.equal(draft.value, text, '履歴は出ないはず');
	});

	test('変換候補を選んでいる間の ↑ ↓ は候補を選ぶだけで、履歴を出さない', async () => {
		await copyDraft(client, 'git status');
		await startComposingInDraft(client);
		// 2回目の Space で変換候補の一覧が出る
		await sendKeySequence([[VK.SPACE], [VK.SPACE]]);
		await settle();

		// ↑↓ で変換が確定したり取り消されたりしていないことを、compositionend が起きないことで見る
		await client.execute(() => {
			window.__e2eCompositionEnds = 0;
			document
				.querySelector('textarea')
				.addEventListener('compositionend', () => window.__e2eCompositionEnds++);
		});
		// ↑ で履歴が出てから ↓ で書きかけに戻ると最後の値では見分けられないので、キーごとに見る
		for (const key of [VK.UP, VK.DOWN]) {
			await sendKeySequence([[key]]);
			await settle();
			const draft = await readDraft(client);
			const name = key === VK.UP ? '↑' : '↓';
			assert.notEqual(draft.value, 'git status', `${name} で履歴は出ないはず`);
			assert.notEqual(draft.value, '', `${name} の後も変換中の文字が残っているはず`);
			assert.equal(
				await client.execute(() => window.__e2eCompositionEnds),
				0,
				`${name} で変換が終わらず、候補を選んでいるままのはず`
			);
		}
	});

	test('履歴の件数を 0 にすると、コピーしても ↑ で何も出ない', async () => {
		await invokeApp(client, 'set_draft_history_size', { size: 0 });
		try {
			await copyDraft(client, 'git status');
			await showDraftAndWaitVisible();
			await sendKeySequence([[VK.UP]]);
			await expectDraftStaysEmpty(client, '件数が 0 のときの ↑ の後の入力欄');
			const buttons = await listDraftButtons(client);
			assert.ok(
				buttons.every((button) => button.position !== 'above'),
				`前・次の列は出ないはず: ${JSON.stringify(buttons)}`
			);
		} finally {
			// 設定ファイルに書かれ、このファイルのほかのテスト (起動し直す) に残るので戻す
			await invokeApp(client, 'set_draft_history_size', { size: DEFAULT_HISTORY_SIZE });
		}
	});

	test('起動し直しても、履歴が残る', async () => {
		await copyDraft(client, 'git status');
		// 保存は画面側の非同期なので、終了する前に、ファイルが出来るのを待つ
		await waitFor(historyExists, (exists) => exists, { label: '履歴のファイルが出来る' });
		await suite.closeClient(client);
		client = await suite.newClient();
		await pasteTarget.activate();

		await showDraftAndWaitVisible();
		await sendKeySequence([[VK.UP]]);
		await settle();
		assert.equal((await readDraft(client)).value, 'git status');
	});

	test('履歴を消すと、起動し直しても履歴が出ない', async () => {
		await copyDraft(client, 'git status');
		await waitFor(historyExists, (exists) => exists, { label: '履歴のファイルが出来る' });
		await invokeApp(client, 'clear_draft_history');
		await waitFor(historyExists, (exists) => !exists, { label: '履歴のファイルが消える' });
		await suite.closeClient(client);
		client = await suite.newClient();
		await pasteTarget.activate();

		await showDraftAndWaitVisible();
		await sendKeySequence([[VK.UP]]);
		await expectDraftStaysEmpty(client, '履歴を消した後の ↑ の後の入力欄');
	});
});
