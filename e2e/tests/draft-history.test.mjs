import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	copyDraft,
	invokeApp,
	listDraftButtons,
	readDraft,
	readSnippetPalette,
	setDraftCaret,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitDraftHidden
} from '../lib/app.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import {
	getDraftWindowHandle,
	getForegroundWindowHandle,
	listVisibleMawokTreeWindows
} from '../lib/os.mjs';
import { cancelComposition, startComposingInDraft, turnImeOff } from '../lib/ime.mjs';
import { beginTestConfig, clearHistory, historyEntryCount } from '../lib/config.mjs';
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

	test('既定の Ctrl+R で検索の一覧が出て読み込み直さず、Enter で選んだ履歴を出し、末尾の ↓ で書きかけに戻る', async () => {
		await copyDraft(client, 'git status');
		await copyDraft(client, 'git diff');
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, '書きかけ');
		// WebView2 は Ctrl+R で画面を読み込み直す。読み込み直すと window が作り直され、この印が消える
		await client.execute(() => (window.__e2eNotReloaded = true));
		// 一覧の行の上にポインターがあると、選んだ行がポインターの下の行へ戻されるので、外へ寄せてから開く
		await client.action('pointer').move({ x: 1, y: 1 }).perform();

		await sendKeySequence([[VK.CONTROL, VK.R]]);
		const palette = await waitFor(
			() => readSnippetPalette(client),
			(current) => current.open && current.inputFocused,
			{ label: 'Ctrl+R で検索の一覧が出て、絞り込みの欄にフォーカスがある' }
		);
		assert.deepEqual(palette.options, ['git diff', 'git status'], '新しい順に出るはず');
		// 読み込み直しが始まるまでの間を見逃さないよう、しばらく待ってから見る
		await settle();
		assert.deepEqual(
			await client.execute(() => ({
				marked: window.__e2eNotReloaded === true,
				value: document.querySelector('textarea')?.value ?? null
			})),
			{ marked: true, value: '書きかけ' },
			'読み込み直さず、書きかけが残るはず'
		);

		await sendKeySequence([[VK.ENTER]]);
		const picked = await waitFor(
			async () => ({ palette: await readSnippetPalette(client), draft: await readDraft(client) }),
			({ palette, draft }) => !palette.open && draft.focused && draft.value === 'git diff',
			{ label: 'Enter で一覧が閉じ、選んだ履歴が入力欄に出る' }
		);
		// 上キーで出したときと同じくカーソルは先頭にあるので、1回目の ↓ は末尾へ移るだけ
		if (picked.draft.selectionStart !== picked.draft.value.length) {
			await sendKeySequence([[VK.DOWN]]);
			await waitFor(
				() => readDraft(client),
				(d) => d.value === 'git diff' && d.selectionStart === d.value.length,
				{ label: '↓ で末尾へ移る' }
			);
		}
		await sendKeySequence([[VK.DOWN]]);
		await waitFor(
			() => readDraft(client),
			(d) => d.value === '書きかけ',
			{ label: '末尾の ↓ で書きかけに戻る' }
		);
		assert.equal(
			await client.execute(() => window.__e2eNotReloaded === true),
			true,
			'最後まで読み込み直していないはず'
		);
	});

	test('既定の Ctrl+N で入力欄が空になり、↑ で書きかけが戻る。WebView2 の新しいウィンドウは開かない', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, '書きかけ');
		const draftHwnd = await getDraftWindowHandle();
		// WebView2 は Ctrl+N で新しいウィンドウを開く。開いた窓はトップレベルにならないこともあるので、子ウィンドウまで比べる
		const before = await listVisibleMawokTreeWindows({ includeChildren: true });

		await sendKeySequence([[VK.CONTROL, VK.N]]);
		await waitFor(
			() => readDraft(client),
			(d) => d.value === '' && d.focused,
			{ label: 'Ctrl+N で入力欄が空になり、フォーカスが残る' }
		);
		await settle();
		assert.deepEqual(
			await listVisibleMawokTreeWindows({ includeChildren: true }),
			before,
			'ウィンドウも子ウィンドウも増えないはず'
		);
		assert.equal(await getForegroundWindowHandle(), draftHwnd, '下書きが前面のまま');

		await sendKeySequence([[VK.UP]]);
		await waitFor(
			() => readDraft(client),
			(d) => d.value === '書きかけ',
			{ label: '↑ で書きかけが戻る' }
		);
	});

	test('履歴を出して「履歴から削除」を押すと、その履歴が消えて書きかけに戻り、起動し直しても出ない', async () => {
		await copyDraft(client, 'git status');
		await copyDraft(client, 'git diff');
		await waitFor(historyEntryCount, (count) => count === 2, { label: '履歴がファイルに入る' });
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, '書きかけ');
		await setDraftCaret(client, 0);
		await sendKeySequence([[VK.UP]]);
		await waitFor(
			() => readDraft(client),
			(d) => d.value === 'git diff',
			{ label: '↑ で新しい方の履歴が出る' }
		);

		await client.$('button[aria-label="履歴から削除"]').click();
		await waitFor(
			() => readDraft(client),
			(d) => d.value === '書きかけ',
			{ label: '消すと書きかけに戻る' }
		);
		await waitFor(historyEntryCount, (count) => count === 1, {
			label: '消した履歴がファイルから消える'
		});
		await setDraftCaret(client, 0);
		await sendKeySequence([[VK.UP]]);
		await waitFor(
			() => readDraft(client),
			(d) => d.value === 'git status',
			{ label: '↑ で消していない方が出る' }
		);

		await suite.closeClient(client);
		client = await suite.newClient();
		await pasteTarget.activate();
		await showDraftAndWaitVisible();
		// 消した履歴が戻っていれば、1回目の ↑ で 'git diff' が出る
		await sendKeySequence([[VK.UP]]);
		await waitFor(
			() => readDraft(client),
			(d) => d.value === 'git status',
			{ label: '起動し直しても、消した履歴は出ない' }
		);
		await sendKeySequence([[VK.UP]]);
		await expectStays(async () => (await readDraft(client)).value, 'git status', {
			label: 'それより古い履歴は無い'
		});
	});

	test('「非表示後に入力をクリア」が 30 秒後なら、隠して 30 秒たってから出すと空から始まり、↑ で書きかけが戻る', async () => {
		await invokeApp(client, 'set_clear_draft_after', { after: '30s' });
		try {
			await showDraftAndWaitVisible();
			await typeIntoDraft(client, '書きかけ');
			// 時間がたつ前に出し直すと、書きかけは残る（出すたびに空にしていないこと）
			await sendKeySequence([[VK.ESCAPE]]);
			await waitDraftHidden('Esc で隠す');
			await showDraftAndWaitVisible('すぐに出し直す');
			await expectStays(async () => (await readDraft(client)).value, '書きかけ', {
				label: '30 秒たつ前は書きかけが残る'
			});
			await sendKeySequence([[VK.ESCAPE]]);
			await waitDraftHidden('Esc で隠す');
			await new Promise((resolve) => setTimeout(resolve, 31_000));

			await showDraftAndWaitVisible('30 秒たってから出す');
			await waitFor(
				() => readDraft(client),
				(d) => d.value === '' && d.focused,
				{ label: '空から始まる' }
			);
			await sendKeySequence([[VK.UP]]);
			await waitFor(
				() => readDraft(client),
				(d) => d.value === '書きかけ',
				{ label: '↑ で書きかけが戻る' }
			);
		} finally {
			// 設定の置き場に書かれ、このファイルのほかのテスト (起動し直す) に残るので戻す
			await invokeApp(client, 'set_clear_draft_after', { after: 'never' });
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
		await cancelComposition(async () => (await readDraft(client)).value);
	});

	test('履歴の件数を 0 にすると、コピーしても ↑ で何も出ない', async () => {
		await invokeApp(client, 'set_draft_history_size', { size: 0 });
		try {
			await copyDraft(client, 'git status');
			await showDraftAndWaitVisible();
			await sendKeySequence([[VK.UP]]);
			await expectDraftStaysEmpty(client, '件数が 0 のときの ↑ の後の入力欄');
			const buttons = await listDraftButtons(client);
			// 空の一覧で通らないよう、いつも出るボタンが読めていることを先に見る
			assert.ok(
				buttons.some((button) => button.text.startsWith('定型文')),
				`ボタンが読めていない: ${JSON.stringify(buttons)}`
			);
			assert.ok(
				buttons.every((button) => button.text !== '前' && button.text !== '次'),
				`前・次のボタンは出ないはず: ${JSON.stringify(buttons)}`
			);
		} finally {
			// 設定の置き場に書かれ、このファイルのほかのテスト (起動し直す) に残るので戻す
			await invokeApp(client, 'set_draft_history_size', { size: DEFAULT_HISTORY_SIZE });
		}
	});

	test('起動し直しても、履歴が残る', async () => {
		await copyDraft(client, 'git status');
		// 保存は画面側の非同期なので、終了する前に、ファイルが出来るのを待つ
		await waitFor(historyEntryCount, (count) => count > 0, { label: '履歴がファイルに入る' });
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
		await waitFor(historyEntryCount, (count) => count > 0, { label: '履歴がファイルに入る' });
		await invokeApp(client, 'clear_draft_history');
		await waitFor(historyEntryCount, (count) => count === 0, {
			label: '履歴がファイルから消える'
		});
		await suite.closeClient(client);
		client = await suite.newClient();
		await pasteTarget.activate();

		await showDraftAndWaitVisible();
		await sendKeySequence([[VK.UP]]);
		await expectDraftStaysEmpty(client, '履歴を消した後の ↑ の後の入力欄');
	});
});
