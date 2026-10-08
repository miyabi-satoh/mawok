import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSuite } from '../lib/setup.mjs';
import {
	closeDraftSettings,
	expandAllRows,
	openSettingsFromDraft,
	readAlert,
	readDraft,
	runAction,
	setDraftValue,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitAlert
} from '../lib/app.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import { waitFor } from '../lib/wait.mjs';

// 既定のアクションの「行を並べ替え」(Windows では sort を Shift_JIS で読み書きする)。
// 既定のアクションはコマンドの行が裸の `sort` なので、PATH で最初に当たる sort が動く。開発機の PATH では Git や uutils の sort が
// 先に当たることがあり、利用者の環境 (Explorer から起動したアプリはレジストリの PATH で、System32 が先) と結果が変わる。
// ここでは System32 を PATH の先頭に置き、E2E のアプリ (tauri-driver から起動し、この PATH を引き継ぐ) でも Windows の sort を当てる
const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
process.env.PATH = `${SYSTEM32};${process.env.PATH}`;

const suite = createSuite();

const SORT = '行を並べ替え';

test.describe('既定のアクションの「行を並べ替え」', () => {
	let testConfig;
	let client;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			language: 'ja',
			hideTextWindowOnBlur: false,
			textWindowAlwaysOnTop: true,
			aiService: 'none',
			aiConsent: null,
			// アクションの項目を書かず、既定のアクションで回す
			actions: null
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

	test('日本語を含む行を、化けずに並べ替える。波ダッシュは全角チルダになって返る', async () => {
		const lines = ['りんご', 'あめ', 'Banana', 'apple', '漢字', 'アイス', 'みかん', '1〜2'];
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'x');
		await setDraftValue(client, lines.join('\n'));
		await runAction(client, SORT);
		const result = await waitFor(
			async () => (await readDraft(client)).value,
			(value) => value !== lines.join('\n'),
			{ label: '並べ替えた下書き', timeout: 10000 }
		);
		console.log('並べ替えた結果:', JSON.stringify(result.split('\n')));
		// 並びは sort の決まり（ロケール）によるので、行の集まりが同じで化けていないことと、入力の順から並べ替わったことを見る
		const expected = lines.map((line) => line.replace('\u301C', '\uFF5E'));
		assert.deepEqual([...result.split('\n')].sort(), [...expected].sort(), result);
		assert.notEqual(result, expected.join('\n'), `並べ替わっていない: ${result}`);
		assert.ok(result.includes('1\uFF5E2'), `波ダッシュは全角チルダで返るはず: ${result}`);
		assert.equal(await readAlert(client), null);
	});

	for (const [label, text] of [
		['絵文字', 'りんご😀\nあめ'],
		['円記号', 'りんご ¥100\nあめ']
	]) {
		test(`${label}を含む下書きは実行せず、表せない文字がある帯を出し、下書きは変わらない`, async () => {
			await showDraftAndWaitVisible();
			await typeIntoDraft(client, 'x');
			await setDraftValue(client, text);
			await runAction(client, SORT);
			const alert = await waitAlert(client, '表せない文字の帯');
			assert.ok(alert.includes('文字コードで表せない文字'), alert);
			assert.equal((await readDraft(client)).value, text);
		});
	}

	test('設定のアクションの行を開くと、コマンドの行にだけ文字コードの選択が出て、sort は Shift_JIS になっている', async () => {
		await showDraftAndWaitVisible();
		const draftHandle = await openSettingsFromDraft(client);
		try {
			await client.$('button[role="tab"]*=アクション').click();
			const panel = await client.$('[role="tabpanel"]:not([hidden])');
			await panel.$('button=追加').waitForDisplayed({ timeout: 5000 });
			await expandAllRows(client, panel);
			const rows = await client.execute(() => {
				const panel = document.querySelector('[role="tabpanel"]:not([hidden])');
				const names = [...panel.querySelectorAll('input')].filter((input) =>
					['英訳', '行を並べ替え'].includes(input.value)
				);
				return names.map((input) => {
					// 名前の欄から上へたどり、コマンドの欄 (textarea) を含む最初の要素を行とみなす
					let row = input.parentElement;
					while (row && !row.querySelector('textarea')) row = row.parentElement;
					const select = row?.querySelector('select');
					return {
						name: input.value,
						command: row?.querySelector('textarea')?.value ?? null,
						encoding: select ? select.value : null,
						options: select ? [...select.options].map((option) => option.textContent.trim()) : null
					};
				});
			});
			console.log('設定の行:', JSON.stringify(rows));
			const sort = rows.find((row) => row.name === '行を並べ替え');
			const translate = rows.find((row) => row.name === '英訳');
			assert.equal(sort?.command, 'sort');
			assert.equal(sort?.encoding, 'shift_jis');
			assert.deepEqual(sort?.options, [
				'UTF-8',
				'Shift_JIS',
				'EUC-JP',
				'JIS (ISO-2022-JP)',
				'UTF-16 LE'
			]);
			assert.equal(translate?.encoding, null, '@ai の行には文字コードの選択が出ないはず');
		} finally {
			await closeDraftSettings(client, draftHandle);
		}
	});
});
