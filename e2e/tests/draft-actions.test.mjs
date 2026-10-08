import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	clickActionOption,
	expectDraftStaysVisible,
	invokeApp,
	listDraftButtons,
	openActions,
	readDraft,
	readSnippetPalette,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitAlert
} from '../lib/app.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import { launchPasteTarget } from '../lib/paste-target.mjs';
import { waitFor } from '../lib/wait.mjs';

// アクション。アクションのボタンとキーは、AI サービスの設定やアクションの数によらず効く。
// 本物の AI サービスには送らないので、AI サービスは「使わない」で回し、AI のアクションを選んだときは失敗の帯が出ることまでを見る
// (「使わない」なら、送る前に Rust 側が断る)。送り先の URL を差し替える口は作らない (通信先を変えられてしまうため)。
// コマンドのアクションの実行は actions-command.test.mjs で見る

const suite = createSuite();

const BUSINESS = {
	name: 'ビジネス向け',
	command: '@ai 丁寧な文に書き直してください。',
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
			actions: [BUSINESS]
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

	/** 下のボタンの列に「アクション」があることを見て、Ctrl+K で一覧を開く */
	async function openActionsWithKey() {
		const buttons = await listDraftButtons(client);
		assert.ok(
			buttons.some((button) => button.text.startsWith('アクション')),
			JSON.stringify(buttons)
		);
		return openActions(client);
	}

	test('AI のアクションも一覧に出て、選ぶと元の文のまま AI を使える状態にするよう促す帯が出る', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');

		await openActionsWithKey();
		await clickActionOption(client, BUSINESS.name);

		const alert = await waitAlert(client, '失敗の帯');
		assert.ok(alert.includes('AI を使える状態になっていません'), alert);
		await expectDraftStaysVisible('AI のアクションを選んだ後');
		const draft = await readDraft(client);
		assert.equal(draft.value, 'abc', '入力欄の中身は変わらないはず');
		assert.equal(draft.focused, true, '入力欄にフォーカスがあるはず');
	});

	test('アクションが0件でも、ボタンが出て、Ctrl+K で一覧が開き、アクションが無い旨が出る', async () => {
		await invokeApp(client, 'set_actions', { actions: [] });
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');

		const palette = await openActionsWithKey();
		assert.deepEqual(palette.options, [], '一覧に項目は無いはず');
		assert.ok(palette.status?.includes('アクションはまだありません'), palette.status);

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
	});
});
