import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSuite } from '../lib/setup.mjs';
import {
	clickActionOption,
	closeDraftSettings,
	invokeApp,
	listDraftButtons,
	openActions,
	openSettingsFromDraft,
	readActionOptions,
	readAlert,
	readDraft,
	runAction,
	setDraftCaret,
	setDraftValue,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitAlert
} from '../lib/app.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { APP_IDENTIFIER } from '../lib/app-conf.mjs';
import { APP_DATA_DIRS, beginTestConfig, tryReadConfig } from '../lib/config.mjs';
import { markLog, readLogSince } from '../lib/files.mjs';
import { getMawokProcessId, isMawokRunning, runPowerShell, setClipboard } from '../lib/os.mjs';
import {
	clickTrayMenuItem,
	closeLeftoverTrayMenu,
	closeTrayOverflow,
	openTrayMenu
} from '../lib/tray.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';

// コマンドのアクションと、AI のキーの資格情報。
// AI のアクションは本物の AI サービスへ送ってしまうので実行しない (送り先を差し替える口は作らない)。
// ここで見るのは、AI を使わない状態でのコマンドのアクション (21. の 21.〜32.) と、キーを入れて消したときの
// 資格情報マネージャー (21. の 15.)。キーは仮の文字列で、使わない

const suite = createSuite();

const STAMP = Date.now();
// 「出さない」のアクションが追記するファイル。アプリは E2E と同じ環境変数で動くので、%TEMP% はここと同じ
const APPEND_FILE = path.join(os.tmpdir(), `mawok-e2e-actions-${STAMP}.txt`);
const LOG_PATH = path.join(APP_DATA_DIRS.local, 'logs', 'Mawok.log');

// more と find は System32 のものをフルパスで呼ぶ。開発機の PATH では、Git や uutils の同じ名前のコマンドが先に当たり、
// 標準入力を読み終えても終わらなかったり (more)、別の意味になったり (find) するため。
// `more`・`find` と名前だけで呼ぶと、この PATH を引き継いだ E2E のアプリでは結果が変わる
const MORE = String.raw`%SystemRoot%\System32\more.com`;
const FIND = String.raw`%SystemRoot%\System32\find.exe`;

// ping の回数は、ほかで動いている ping と見分けるため、ありそうにない数にする
const LONG_PING = `ping -n 31 127.0.0.1 >nul & ${MORE}`;
const QUIT_PING = `ping -n 61 127.0.0.1 >nul & ${MORE}`;

const action = (name, command, output = 'replace') => ({ name, command, output, enabled: true });
const ACTIONS = [
	action('大文字', 'findstr /n "^"'),
	action('ビジネス向け', '@ai 丁寧な文に書き直してください。'),
	action('改行入り', 'echo a\necho b'),
	action('待つ', LONG_PING),
	action('無いコマンド', 'mawok-no-such-command'),
	action('失敗する', 'echo oops 1>&2 & exit /b 3'),
	action('何も返さない', `${MORE} >nul`),
	// 受け取った引数をそのまま JSON で返す。E2E は node で動いているので node を使う
	action(
		'引数',
		`"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" {{t}}`
	),
	action('日付', 'echo %DATE%', 'insert'),
	action('記録', `${MORE} >> "${APPEND_FILE}"`, 'none'),
	action('終了まで待つ', QUIT_PING)
];

/** 入力欄の下の知らせ (実行している間の「…を実行しています」、終わった後の「…を実行しました」)。出ていなければ null */
async function readStatus(client) {
	return client.execute(
		() => document.querySelector('main p[role="status"]')?.textContent.trim() ?? null
	);
}

async function isDraftReadOnly(client) {
	return client.execute(() => document.querySelector('textarea').readOnly);
}

/** 書いた下書きの中身が、アクションの結果で `expected` に変わるのを待つ */
const waitDraftValue = (client, expected, label) =>
	waitFor(
		async () => (await readDraft(client)).value,
		(value) => value === expected,
		{
			label,
			timeout: 10000
		}
	);

/** コマンド行に `marker` を含む ping.exe のプロセス ID */
async function listPings(marker) {
	const stdout = await runPowerShell(
		`@(Get-CimInstance Win32_Process -Filter "Name = 'ping.exe'" | Where-Object { $_.CommandLine -like "*$($args[0])*" } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`,
		[marker]
	);
	const parsed = JSON.parse(stdout.trim() || '[]');
	return Array.isArray(parsed) ? parsed : [parsed];
}

/** AI サービスのキーを入れる資格情報の名前 (ai.rs の credential_user と、secrets.rs のサービス名) */
const credentialName = (service) => `${service}-api-key.${APP_IDENTIFIER}`;

async function hasCredential(service) {
	const stdout = await runPowerShell('cmdkey /list | Out-String');
	return stdout.includes(credentialName(service));
}

test.describe('コマンドのアクション', () => {
	let testConfig;
	let client;
	let pid;
	let logStart;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({
			language: 'ja',
			hideTextWindowOnBlur: true,
			textWindowAlwaysOnTop: true,
			// ユーザーの設定でサービスを選んでいても、AI を使わない状態で回す
			aiService: 'none',
			aiConsent: null,
			actions: ACTIONS
		});
		logStart = markLog(LOG_PATH);
	});
	test.after(async () => {
		try {
			await testConfig?.restore();
			await fs.rm(APPEND_FILE, { force: true });
		} finally {
			await suite.after();
		}
	});

	test.beforeEach(async () => {
		pid = null;
		client = await suite.newClient();
		pid = await getMawokProcessId();
		await setJapanese(client);
	});
	test.afterEach(async () => {
		try {
			await closeLeftoverTrayMenu(pid);
			await closeTrayOverflow();
		} finally {
			await suite.closeClient(client);
		}
	});

	test('AI のキーを入れると資格情報マネージャーに入り、消すと残らず、AI サービスの選択は残る (15.)', async (t) => {
		// 本物のキーがあるかもしれないので、キーがまだ無い AI サービスで見る
		let service = null;
		for (const candidate of ['openai', 'anthropic', 'gemini']) {
			if (!(await hasCredential(candidate))) {
				service = candidate;
				break;
			}
		}
		if (service === null) {
			t.skip('どの AI サービスのキーも、資格情報マネージャーに前からある');
			return;
		}
		const name = credentialName(service);
		try {
			await invokeApp(client, 'set_ai_service', { service });
			await invokeApp(client, 'set_ai_key', { key: `e2e-dummy-key-${STAMP}` });
			assert.equal(await hasCredential(service), true, `${name} ができるはず`);
			assert.equal(await invokeApp(client, 'has_ai_key'), true);

			await invokeApp(client, 'delete_ai_key');
			assert.equal(await hasCredential(service), false, `${name} が残らないはず`);
			assert.equal(await invokeApp(client, 'has_ai_key'), false);
			const config = await tryReadConfig();
			assert.equal(config?.aiService, service, 'AI サービスの選択は残るはず');
		} finally {
			// 途中で落ちても仮のキーを残さない (前から無かったサービスなので、あれば入れたもの)
			if (await hasCredential(service)) await invokeApp(client, 'delete_ai_key').catch(() => {});
			await invokeApp(client, 'set_ai_service', { service: 'none' });
		}
	});

	test('設定で足すと、等幅のコマンドの欄と結果の出し方が出て、! の注意の出し入れ、Enter と貼り付けの改行の扱いが効く (21.)', async () => {
		await showDraftAndWaitVisible();
		const draftHandle = await openSettingsFromDraft(client);
		try {
			await client.$('button[role="tab"]*=アクション').click();
			const panel = await client.$('[role="tabpanel"]:not([hidden])');
			const addButton = await panel.$('button=追加');
			await addButton.waitForDisplayed({ timeout: 5000 });
			const before = (await panel.$$('textarea')).length;
			await addButton.click();
			const fields = await waitFor(
				() => panel.$$('textarea'),
				(found) => found.length === before + 1,
				{ label: '足した行のコマンドの欄' }
			);
			const command = fields[fields.length - 1];
			const row = await client.execute((element) => {
				const font = getComputedStyle(element).fontFamily;
				const group = element.closest('div.flex.flex-col')?.parentElement;
				const outputs = [
					...(group?.querySelectorAll('[role="group"] button, [role="radiogroup"] button') ?? [])
				].map((button) => button.textContent.trim());
				return { font, outputs };
			}, command);
			assert.match(row.font, /mono|consolas|courier/i, `等幅のはず: ${row.font}`);
			assert.deepEqual(row.outputs, ['置き換える', '挿入', '出さない']);

			const warning = () =>
				client.execute(
					(element) => element.parentElement.textContent.includes('Windows の cmd の決まり'),
					command
				);
			await command.setValue('echo {{t}}!');
			await waitFor(warning, (shown) => shown === true, { label: '! の注意が出る' });
			await command.setValue('echo {{t}}');
			await waitFor(warning, (shown) => shown === false, { label: '! の注意が消える' });

			// Enter は改行を入れない。貼り付けた改行は残す (本物のキー入力で見る)
			await command.click();
			await client.execute(
				(element) => element.setSelectionRange(element.value.length, element.value.length),
				command
			);
			await sendKeySequence([[VK.ENTER]]);
			await expectStays(() => command.getValue(), 'echo {{t}}', {
				label: 'Enter で改行が入らないはず',
				duration: 500
			});
			await client.execute((element) => element.select(), command);
			await setClipboard('echo 1\necho 2');
			await sendKeySequence([[VK.CONTROL, VK.V]]);
			await waitFor(
				() => command.getValue(),
				(value) => value === 'echo 1\necho 2',
				{
					label: '貼り付けた2行'
				}
			);
			await waitFor(
				tryReadConfig,
				(config) => config?.actions?.some((saved) => saved.command === 'echo 1\necho 2'),
				{ label: 'config.toml に保存された2行のコマンド' }
			);
		} finally {
			await closeDraftSettings(client, draftHandle);
			// 足した行を消す (ほかのテストの一覧に混ぜない)
			await invokeApp(client, 'set_actions', { actions: ACTIONS });
		}
	});

	test('改行を含むコマンドは実行せず、帯で知らせて下書きは変わらない (21.)', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');
		await runAction(client, '改行入り');
		const alert = await waitAlert(client, '改行の帯');
		assert.ok(alert.includes('改行を含むコマンドの行は実行できません'), alert);
		assert.equal((await readDraft(client)).value, 'abc');
	});

	test('AI を使わなくても、アクションのボタンと一覧に、コマンドのアクションも AI のアクションも出て、@ai の自由入力は AI を使えるようにする帯になる (22.)', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');
		const buttons = await listDraftButtons(client);
		assert.ok(
			buttons.some((button) => button.text.startsWith('アクション')),
			JSON.stringify(buttons)
		);

		await openActions(client);
		const options = await readActionOptions(client);
		assert.deepEqual(
			options.find((option) => option.label === '大文字'),
			{ label: '大文字', preview: 'findstr /n "^"' }
		);
		// AI を使えなくても、AI のアクションも出す (選んだときに失敗の帯で知らせる。draft-actions.test.mjs)
		assert.ok(
			options.some((option) => option.label === 'ビジネス向け'),
			`AI のアクションも出るはず: ${JSON.stringify(options)}`
		);

		const filter = await client.$('[role="dialog"] input[role="combobox"]');
		await filter.setValue('@ai 関西弁に');
		await waitFor(
			() => readActionOptions(client),
			(current) => current.some((option) => option.label === 'この内容で実行'),
			{ label: '「この内容で実行」' }
		);
		await clickActionOption(client, 'この内容で実行');
		const alert = await waitAlert(client, 'AI を使えない帯');
		assert.ok(alert.includes('AI を使える状態になっていません'), alert);
		assert.equal((await readDraft(client)).value, 'abc');
	});

	test('コマンドの結果で下書きが置き換わる (23.)', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'hello mawok');
		await runAction(client, '大文字');
		await waitDraftValue(client, '1:hello mawok', '置き換わった下書き');
		const draft = await readDraft(client);
		assert.equal(draft.focused, true, '入力欄にフォーカスがあるはず');
	});

	test('実行している間に Esc で取り消すと、すぐ元の文のまま書き換えられる状態に戻り、コマンドが残らない (24.)', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');
		await runAction(client, '待つ');
		await waitFor(
			() => readStatus(client),
			(status) => status?.includes('待つを実行しています'),
			{
				label: '実行している間の知らせ'
			}
		);
		await waitFor(
			() => listPings('-n 31'),
			(pings) => pings.length > 0,
			{
				label: 'ping が動き出す'
			}
		);
		assert.equal(await isDraftReadOnly(client), true, '実行している間は書き換えられないはず');

		await sendKeySequence([[VK.ESCAPE]]);
		await waitFor(
			() => isDraftReadOnly(client),
			(readOnly) => readOnly === false,
			{
				label: '書き換えられる状態に戻る',
				timeout: 1000
			}
		);
		const draft = await readDraft(client);
		assert.equal(draft.value, 'abc');
		assert.equal(draft.focused, true, '入力欄にフォーカスがあるはず');
		await waitFor(
			() => listPings('-n 31'),
			(pings) => pings.length === 0,
			{
				label: 'ping が残らない',
				timeout: 3000
			}
		);
	});

	test('見つからないコマンドは、終了コード 1 の失敗と、文字化けしない cmd の標準エラーを帯に出す (25.)', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');
		await runAction(client, '無いコマンド');
		const alert = await waitAlert(client, '失敗の帯');
		assert.ok(alert.includes('終了コード 1'), alert);
		assert.ok(alert.includes('として認識されていません'), alert);
		assert.equal((await readDraft(client)).value, 'abc');
	});

	test('失敗したコマンドの終了コードと標準エラー、何も返さないコマンドを帯に出し、下書きは変わらない (26.)', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');
		await runAction(client, '失敗する');
		const failed = await waitAlert(client, '終了コード 3 の帯');
		assert.ok(failed.includes('終了コード 3'), failed);
		assert.ok(failed.includes('oops'), failed);

		await runAction(client, '何も返さない');
		const empty = await waitFor(
			() => readAlert(client),
			(alert) => alert?.includes('何も返りませんでした'),
			{ label: '何も返らない帯', timeout: 10000 }
		);
		assert.ok(empty);
		assert.equal((await readDraft(client)).value, 'abc');
	});

	test('下書きの全体が、記号も改行もそのまま1つの引数で渡る (28.)', async () => {
		const text = 'a "b" \\ c; echo x\n$HOME %PATH% !x!';
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'x');
		await setDraftValue(client, text);
		await runAction(client, '引数');
		const result = await waitFor(
			async () => (await readDraft(client)).value,
			(value) => value !== text,
			{ label: '引数の結果', timeout: 10000 }
		);
		assert.deepEqual(JSON.parse(result), [text]);
	});

	test('「挿入」は、カーソルの位置と選んだ範囲の後ろに入れ、下書きが空でも実行できる (29.)', async () => {
		const date = execFileSync('cmd.exe', ['/d', '/c', 'echo %DATE%'], { encoding: 'utf8' }).trim();
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abcdef');
		await setDraftCaret(client, 3);
		await runAction(client, '日付');
		await waitDraftValue(client, `abc${date}def`, 'カーソルの位置に差し込む');

		await setDraftValue(client, 'abcdef');
		await setDraftCaret(client, 1, 3);
		await runAction(client, '日付');
		await waitDraftValue(client, `abc${date}def`, '選んだ範囲の後ろに差し込む');

		await setDraftValue(client, '');
		await runAction(client, '日付');
		await waitDraftValue(client, date, '空の下書きに差し込む');
	});

	test('「出さない」は、下書きを変えず、実行したことだけを知らせて消え、コマンドには下書きが渡る (30.)', async () => {
		const text = `mawok-e2e-${STAMP}`;
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, text);
		await runAction(client, '記録');
		await waitFor(
			() => readStatus(client),
			(status) => status === '記録を実行しました',
			{
				label: '実行したことの知らせ',
				timeout: 10000
			}
		);
		assert.equal((await readDraft(client)).value, text);
		await waitFor(
			() => readStatus(client),
			(status) => status === null,
			{
				label: '知らせが消える',
				timeout: 10000
			}
		);
		const written = await fs.readFile(APPEND_FILE, 'utf8');
		assert.ok(written.includes(text), written);
	});

	test('絞り込みの欄に書いたコマンドを、登録しなくても実行できる (31.)', async () => {
		await showDraftAndWaitVisible();
		// Windows の find は LF だけの改行を行の区切りにしないので、1行で見る
		await typeIntoDraft(client, 'abc');
		await openActions(client);
		const filter = await client.$('[role="dialog"] input[role="combobox"]');
		await filter.setValue(`${FIND} /c /v ""`);
		await waitFor(
			() => readActionOptions(client),
			(current) => current.some((option) => option.label === 'この内容で実行'),
			{ label: '「この内容で実行」' }
		);
		await clickActionOption(client, 'この内容で実行');
		await waitDraftValue(client, '1', '行の数で置き換わった下書き');
	});

	test('ログには、コマンドの行・渡した文・出力を書かず、番号と失敗の種類、終了コードだけを残す (27.)', async () => {
		const log = readLogSince(LOG_PATH, logStart);
		for (const secret of [
			'mawok-no-such-command',
			'findstr',
			'hello mawok',
			'oops',
			'127.0.0.1',
			`mawok-e2e-${STAMP}`,
			'関西弁'
		]) {
			assert.equal(log.includes(secret), false, `ログに「${secret}」があってはいけない`);
		}
		assert.match(log, /action \d+ started \(command\)/);
		assert.match(log, /action \d+ failed: .*3/);
	});

	test('実行している間にトレイから終了すると、コマンドが残らない (32.)', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');
		await runAction(client, '終了まで待つ');
		await waitFor(
			() => listPings('-n 61'),
			(pings) => pings.length > 0,
			{
				label: 'ping が動き出す'
			}
		);

		const { hwnd } = await openTrayMenu(pid);
		await clickTrayMenuItem(hwnd, '終了');
		await waitFor(isMawokRunning, (running) => running === false, {
			label: 'トレイの「終了」で終わる',
			timeout: 10000
		});
		await waitFor(
			() => listPings('-n 61'),
			(pings) => pings.length === 0,
			{
				label: 'ping が残らない',
				timeout: 3000
			}
		);
	});
});
