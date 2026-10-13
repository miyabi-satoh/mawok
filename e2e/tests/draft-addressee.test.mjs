import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	expectDraftStaysVisible,
	listDraftButtons,
	readDraft,
	sendToAddressee,
	setDraftValue,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitAlert
} from '../lib/app.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import { waitFor } from '../lib/wait.mjs';

// テキストの1行目の宛先 (@ai・@sh・@all・デバイスの名前)。宛先の候補の出し入れ、入力欄の役割、
// 送るボタンの名前、宛先だけで中身が無いときの帯を見る。
// 候補の絞り込みと宛先の読み方は src/lib/addressee.test.ts で見ている。@sh の実行は actions-command.test.mjs、
// @ai の失敗は draft-actions.test.mjs で見る。デバイスへ実際に送ることはしない (つながらない文書用のアドレスにしてある)

const suite = createSuite();

const DEVICE = 'MacBook Air';

/** 出ている宛先の候補の文字 (出ていなければ null) */
async function readAddressList(client) {
	return client.execute(() => {
		const list = document.querySelector('[role="listbox"]');
		if (!list) return null;
		return [...list.querySelectorAll('[role="option"]')].map((option) =>
			option.querySelector('span')?.textContent.trim()
		);
	});
}

/** 入力欄の役割。候補が出ている間だけ combobox になる */
async function readDraftRole(client) {
	return client.execute(() => {
		const textarea = document.querySelector('textarea');
		return textarea.getAttribute('role') ?? 'textbox';
	});
}

test.describe('1行目の宛先', () => {
	let testConfig;
	let client;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			language: 'ja',
			hideTextWindowOnBlur: false,
			textWindowAlwaysOnTop: true,
			showTextWindowButtons: true,
			devices: [
				{
					name: DEVICE,
					publicKey: 'ab'.repeat(32),
					// 文書用のアドレス (TEST-NET-1) なので、どこにも繋がらない
					address: '192.0.2.1',
					sendTo: true
				}
			]
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
	});
	test.afterEach(async () => {
		await suite.closeClient(client);
	});

	test('1行目の先頭で @ を打つと宛先の候補が出て入力欄が combobox になり、Esc で候補だけが閉じて textbox に戻る', async () => {
		await showDraftAndWaitVisible();
		assert.equal(await readDraftRole(client), 'textbox', 'ふだんは textbox のはず');

		await typeIntoDraft(client, '@');
		const candidates = await waitFor(
			() => readAddressList(client),
			(list) => list !== null,
			{ label: '宛先の候補' }
		);
		assert.deepEqual(candidates, ['@ai', '@sh', '@all', `@${DEVICE}`]);
		assert.equal(await readDraftRole(client), 'combobox');

		await sendKeySequence([[VK.ESCAPE]]);
		await waitFor(
			() => readAddressList(client),
			(list) => list === null,
			{ label: '候補が閉じる' }
		);
		await expectDraftStaysVisible('候補を Esc で閉じた後');
		assert.equal(await readDraftRole(client), 'textbox');
		assert.equal((await readDraft(client)).value, '@');
	});

	test('「@s」に絞られた候補を Tab で入れると「@sh 」になり、送るボタンが「実行」になる', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, '@s');
		const candidates = await waitFor(
			() => readAddressList(client),
			(list) => list?.length === 1,
			{ label: '@sh に絞られる' }
		);
		assert.deepEqual(candidates, ['@sh']);

		await sendKeySequence([[VK.TAB]]);
		await waitFor(
			() => readDraft(client),
			(draft) => draft.value === '@sh ' && draft.focused,
			{ label: '@sh が入り、入力欄にフォーカスがある' }
		);
		assert.equal(await readAddressList(client), null, '入れた後は候補が閉じるはず');

		const buttons = await listDraftButtons(client);
		assert.ok(
			buttons.some((button) => button.text === '実行'),
			JSON.stringify(buttons)
		);
	});

	test('本文の途中の @ や、知らない宛先では、候補も「実行」も出ず、送るボタンは「送信」のまま', async () => {
		await showDraftAndWaitVisible();
		await setDraftValue(client, 'メールは a@example.com へ。\n@tanaka お願いします');
		assert.equal(await readAddressList(client), null);
		const buttons = await listDraftButtons(client);
		assert.ok(
			buttons.some((button) => button.text === '送信'),
			JSON.stringify(buttons)
		);
		assert.equal(
			buttons.some((button) => button.text === '実行'),
			false,
			JSON.stringify(buttons)
		);
	});

	test('デバイスの宛先だけで2行目から下が無いと、送らずに知らせる帯が出て、テキストは変わらない', async () => {
		await showDraftAndWaitVisible();
		await setDraftValue(client, `@${DEVICE}`);
		await sendToAddressee();
		const alert = await waitAlert(client, '送るテキストが無い帯');
		assert.ok(alert.includes('2行目から下に、送るテキストを書いてください'), alert);
		await expectDraftStaysVisible('宛先だけを送ろうとした後');
		assert.equal((await readDraft(client)).value, `@${DEVICE}`);
	});

	test('@sh の後ろが空のまま送るキーで出すと、指示かコマンドを書くよう知らせる帯が出る', async () => {
		await showDraftAndWaitVisible();
		await setDraftValue(client, '@sh\nabc');
		await sendToAddressee();
		const alert = await waitAlert(client, '宛先の後ろが空の帯');
		assert.ok(alert.includes('宛先の後ろに、指示かコマンドを書いてください'), alert);
		assert.equal((await readDraft(client)).value, '@sh\nabc');
	});
});
