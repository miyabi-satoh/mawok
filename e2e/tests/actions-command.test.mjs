import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSuite } from '../lib/setup.mjs';
import {
	closeDraftSettings,
	invokeApp,
	listDraftButtons,
	openSnippetPalette,
	openSettingsFromDraft,
	readSnippetOptions,
	readAlert,
	readDraft,
	runSnippet,
	setDraftCaret,
	runDraft,
	setDraftValue,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitAlert
} from '../lib/app.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { PROFILE_IDENTIFIER } from '../lib/app-conf.mjs';
import { APP_DATA_DIRS, beginTestConfig, tryReadConfig } from '../lib/config.mjs';
import { markLog, readLogSince } from '../lib/files.mjs';
import { getMawokProcessId, isMawokRunning, runPowerShell, setClipboard } from '../lib/os.mjs';
import {
	clickTrayMenuItem,
	closeLeftoverTrayMenu,
	closeTrayOverflow,
	openTrayMenu
} from '../lib/tray.mjs';
import { waitFor } from '../lib/wait.mjs';

// @sh の定型文と1行目の @sh、AI のキーの資格情報。
// @ai は本物の AI サービスへ送ってしまうので実行しない (送り先を差し替える口は作らない)。
// ここで見るのは、AI を使わない状態での @sh (21. の 21.〜32.) と、キーを入れて消したときの
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

const sh = (name, command, output = 'replace') => ({
	name,
	body: `@sh ${command}`,
	output,
	enabled: true
});
const SNIPPETS = [
	sh('大文字', 'findstr /n "^"'),
	{
		name: 'ビジネス向け',
		body: '@ai 丁寧な文に書き直してください。',
		output: 'replace',
		enabled: true
	},
	sh('待つ', LONG_PING),
	sh('無いコマンド', 'mawok-no-such-command'),
	sh('失敗する', 'echo oops 1>&2 & exit /b 3'),
	sh('何も返さない', `${MORE} >nul`),
	// 標準入力で受け取った文をそのまま JSON で返す。E2E は node で動いているので node を使う
	sh(
		'標準入力',
		`"${process.execPath}" -e "process.stdout.write(JSON.stringify(require('fs').readFileSync(0,'utf8')))"`
	),
	sh('日付', 'echo %DATE%', 'insert'),
	sh('記録', `${MORE} >> "${APPEND_FILE}"`, 'none'),
	sh('終了まで待つ', QUIT_PING)
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
const credentialName = (service) => `${service}-api-key.${PROFILE_IDENTIFIER}`;

async function hasCredential(service) {
	const stdout = await runPowerShell('cmdkey /list | Out-String');
	return stdout.includes(credentialName(service));
}

test.describe('@sh のコマンド', () => {
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
			snippets: SNIPPETS
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

	test('設定で足した定型文は、本文を @sh で始めると結果の出し方が出て、Enter・貼り付けの改行の扱いが効く (21.)', async () => {
		await showDraftAndWaitVisible();
		const draftHandle = await openSettingsFromDraft(client);
		try {
			await client.$('button[role="tab"]*=定型文').click();
			const panel = await client.$('[role="tabpanel"]:not([hidden])');
			const addButton = await panel.$('button=追加');
			await addButton.waitForDisplayed({ timeout: 5000 });
			const before = (await panel.$$('textarea')).length;
			await addButton.click();
			const fields = await waitFor(
				() => panel.$$('textarea'),
				(found) => found.length === before + 1,
				{ label: '足した行の本文の欄' }
			);
			const body = fields[fields.length - 1];
			const readOutputs = () =>
				client.execute((element) => {
					const group = element.closest('div.flex.flex-col')?.parentElement;
					return [
						...(group?.querySelectorAll('[role="group"] button, [role="radiogroup"] button') ?? [])
					].map((button) => button.textContent.trim());
				}, body);

			// 宛先で始まらない本文は、挿入するだけの文なので、結果の出し方は出ない
			assert.deepEqual(await readOutputs(), []);

			await body.setValue('@sh echo hi');
			await waitFor(readOutputs, (outputs) => outputs.join() === '置換,挿入,出さない', {
				label: '結果の出し方が出る'
			});

			// 本文は複数行にできるので Enter は改行を入れる。貼り付けた改行も残す (本物のキー入力で見る)
			await body.click();
			await client.execute(
				(element) => element.setSelectionRange(element.value.length, element.value.length),
				body
			);
			await sendKeySequence([[VK.ENTER]]);
			await waitFor(
				() => body.getValue(),
				(value) => value === '@sh echo hi\n',
				{ label: 'Enter で改行が入る' }
			);
			// 2行目から下がある本文は、挿入する文なので結果の出し方は出ない
			await client.execute((element) => element.select(), body);
			await setClipboard('@sh echo 1\necho 2');
			await sendKeySequence([[VK.CONTROL, VK.V]]);
			await waitFor(
				() => body.getValue(),
				(value) => value === '@sh echo 1\necho 2',
				{
					label: '貼り付けた2行'
				}
			);
			await waitFor(
				tryReadConfig,
				(config) => config?.snippets?.some((saved) => saved.body === '@sh echo 1\necho 2'),
				{ label: 'config.toml に保存された2行の本文' }
			);
		} finally {
			await closeDraftSettings(client, draftHandle);
			// 足した行を消す (ほかのテストの一覧に混ぜない)
			await invokeApp(client, 'set_snippets', { snippets: SNIPPETS });
		}
	});

	test('AI を使わなくても、定型文のボタンと一覧に、@sh の定型文も @ai の定型文も出て、1行目の @ai は AI を使えるようにする帯になる (22.)', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');
		const buttons = await listDraftButtons(client);
		assert.ok(
			buttons.some((button) => button.text.startsWith('定型文')),
			JSON.stringify(buttons)
		);
		assert.equal(
			buttons.some((button) => button.text.startsWith('アクション')),
			false,
			JSON.stringify(buttons)
		);

		await openSnippetPalette(client);
		const options = await readSnippetOptions(client);
		assert.deepEqual(
			options.find((option) => option.label === '大文字'),
			{ label: '大文字', preview: '@sh findstr /n "^"' }
		);
		// AI を使えなくても、@ai の定型文も出す (選んだときに失敗の帯で知らせる。draft-actions.test.mjs)
		assert.ok(
			options.some((option) => option.label === 'ビジネス向け'),
			`@ai の定型文も出るはず: ${JSON.stringify(options)}`
		);
		await sendKeySequence([[VK.ESCAPE]]);

		await setDraftValue(client, '@ai 関西弁に\nabc');
		await runDraft();
		const alert = await waitAlert(client, 'AI を使えない帯');
		assert.ok(alert.includes('AI を使える状態になっていません'), alert);
		assert.equal((await readDraft(client)).value, '@ai 関西弁に\nabc');
	});

	test('コマンドの結果で下書きが置き換わる (23.)', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'hello mawok');
		await runSnippet(client, '大文字');
		await waitDraftValue(client, '1:hello mawok', '置き換わった下書き');
		const draft = await readDraft(client);
		assert.equal(draft.focused, true, '入力欄にフォーカスがあるはず');
	});

	test('実行している間に Esc で取り消すと、すぐ元の文のまま書き換えられる状態に戻り、コマンドが残らない (24.)', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');
		await runSnippet(client, '待つ');
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
		await runSnippet(client, '無いコマンド');
		const alert = await waitAlert(client, '失敗の帯');
		assert.ok(alert.includes('終了コード 1'), alert);
		assert.ok(alert.includes('として認識されていません'), alert);
		assert.equal((await readDraft(client)).value, 'abc');
	});

	test('失敗したコマンドの終了コードと標準エラー、何も返さないコマンドを帯に出し、下書きは変わらない (26.)', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');
		await runSnippet(client, '失敗する');
		const failed = await waitAlert(client, '終了コード 3 の帯');
		assert.ok(failed.includes('終了コード 3'), failed);
		assert.ok(failed.includes('oops'), failed);

		await runSnippet(client, '何も返さない');
		const empty = await waitFor(
			() => readAlert(client),
			(alert) => alert?.includes('何も返りませんでした'),
			{ label: '何も返らない帯', timeout: 10000 }
		);
		assert.ok(empty);
		assert.equal((await readDraft(client)).value, 'abc');
	});

	test('下書きの全体が、記号も改行もそのまま標準入力で渡る (28.)', async () => {
		const text = 'a "b" \\ c; echo x\n$HOME %PATH% !x!';
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'x');
		await setDraftValue(client, text);
		await runSnippet(client, '標準入力');
		const result = await waitFor(
			async () => (await readDraft(client)).value,
			(value) => value !== text,
			{ label: '標準入力の結果', timeout: 10000 }
		);
		assert.equal(JSON.parse(result), text);
	});

	test('「挿入」は、カーソルの位置と選んだ範囲の後ろに入れ、下書きが空でも実行できる (29.)', async () => {
		const date = execFileSync('cmd.exe', ['/d', '/c', 'echo %DATE%'], { encoding: 'utf8' }).trim();
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abcdef');
		await setDraftCaret(client, 3);
		await runSnippet(client, '日付');
		await waitDraftValue(client, `abc${date}def`, 'カーソルの位置に挿入');

		await setDraftValue(client, 'abcdef');
		await setDraftCaret(client, 1, 3);
		await runSnippet(client, '日付');
		await waitDraftValue(client, `abc${date}def`, '選んだ範囲の後ろに差し込む');

		await setDraftValue(client, '');
		await runSnippet(client, '日付');
		await waitDraftValue(client, date, '空の下書きに差し込む');
	});

	test('「出さない」は、下書きを変えず、実行したことだけを知らせて消え、コマンドには下書きが渡る (30.)', async () => {
		const text = `mawok-e2e-${STAMP}`;
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, text);
		await runSnippet(client, '記録');
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

	test('1行目に @sh と書いてコピーして閉じる・実行のキーで出すと、登録しなくても、2行目から下を標準入力にして実行し、全体が結果で置き換わる (31.)', async () => {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, 'abc');
		// Windows の find は LF だけの改行を行の区切りにしないので、1行で見る
		await setDraftValue(client, `@sh ${FIND} /c /v ""\nabc`);
		// 1行目が @sh のときは、コピーのボタンが「実行」になる
		await waitFor(
			() => listDraftButtons(client),
			(buttons) => buttons.some((button) => button.text === '実行'),
			{ label: 'ボタンが「実行」になる' }
		);
		await runDraft();
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
		await runSnippet(client, '終了まで待つ');
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
