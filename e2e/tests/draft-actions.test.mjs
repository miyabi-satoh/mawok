import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	clickSnippetOption,
	expectDraftStaysVisible,
	invokeApp,
	listDraftButtons,
	openSnippetPalette,
	readDraft,
	readSnippetPalette,
	sendToAddressee,
	setDraftValue,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitAlert
} from '../lib/app.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import { launchPasteTarget } from '../lib/paste-target.mjs';
import { waitFor } from '../lib/wait.mjs';

// @ai の定型文と、1行目の @ai。定型文の一覧のボタンとキーは、AI サービスの設定や定型文の数によらず効く。
// 本物の AI サービスには送らないので、AI サービスは「使わない」で回し、@ai を出したときは失敗の帯が出ることまでを見る
// (「使わない」なら、送る前に Rust 側が断る)。送り先の URL を差し替える口は作らない (通信先を変えられてしまうため)。
// @sh の実行は actions-command.test.mjs で見る

const suite = createSuite();

const BUSINESS = {
	name: 'ビジネス向け',
	body: '@ai 丁寧な文に書き直してください。',
	output: 'replace'
};

test.describe('AI を使えないとき', () => {
	let testConfig;
	let client;
	let pasteTarget;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			hideTextWindowOnBlur: true,
			textWindowAlwaysOnTop: true,
			// ユーザーの設定でサービスを選んでいても、了解とキーがない状態で回す
			aiService: 'none',
			aiConsent: null,
			snippets: [BUSINESS]
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

	/** ボタンの列に「定型文」があることを見て、Ctrl+K で一覧を開く */
	async function openPaletteWithKey() {
		const buttons = await listDraftButtons(client);
		assert.ok(
			buttons.some((button) => button.text.startsWith('定型文')),
			JSON.stringify(buttons)
		);
		return openSnippetPalette(client);
	}

	test('@ai の定型文も一覧に出て、選ぶと元の文のまま AI を使える状態にするよう促す帯が出る', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');

		await openPaletteWithKey();
		await clickSnippetOption(client, BUSINESS.name);

		const alert = await waitAlert(client, '失敗の帯');
		assert.ok(alert.includes('AI を使える状態になっていません'), alert);
		await expectDraftStaysVisible('@ai の定型文を選んだ後');
		const draft = await readDraft(client);
		assert.equal(draft.value, 'abc', '入力欄の中身は変わらないはず');
		assert.equal(draft.focused, true, '入力欄にフォーカスがあるはず');
	});

	test('1行目に @ai と書いて送るキーで出しても、元の文のまま AI を使える状態にするよう促す帯が出る', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');
		const text = '@ai 関西弁に\nabc';
		await setDraftValue(client, text);

		await sendToAddressee();

		const alert = await waitAlert(client, '失敗の帯');
		assert.ok(alert.includes('AI を使える状態になっていません'), alert);
		await expectDraftStaysVisible('1行目の @ai を出した後');
		assert.equal((await readDraft(client)).value, text, '入力欄の中身は変わらないはず');
	});

	test('定型文が0件でも、ボタンが出て、Ctrl+K で一覧が開き、定型文が無い旨が出る', async () => {
		await invokeApp(client, 'set_snippets', { snippets: [] });
		try {
			await showDraftAndWaitVisible();
			await typeIntoDraft(client, 'abc');

			const palette = await openPaletteWithKey();
			// 一覧の項目は、末尾の「テキストを定型文に登録」だけ
			assert.equal(palette.options.length, 1, JSON.stringify(palette.options));
			assert.ok(palette.status?.includes('定型文はまだありません'), palette.status);

			// Esc で一覧だけが閉じ、入力欄に戻る
			await sendKeySequence([[VK.ESCAPE]]);
			await waitFor(
				() => readSnippetPalette(client),
				(current) => !current.open,
				{
					label: '一覧が閉じる'
				}
			);
			await expectDraftStaysVisible('一覧を閉じた後');
			const draft = await readDraft(client);
			assert.equal(draft.value, 'abc');
			assert.equal(draft.focused, true, '入力欄にフォーカスがあるはず');
		} finally {
			// 設定ファイルに書かれ、このファイルのほかのテストに残るので戻す
			await invokeApp(client, 'set_snippets', { snippets: [BUSINESS] });
		}
	});
});
