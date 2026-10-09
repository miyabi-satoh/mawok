import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS_TITLE, TRAY_MENU_JA } from '../lib/app-conf.mjs';
import {
	KEY,
	closeSettings,
	draftState,
	draftTexts,
	focusWindowElement,
	hideDraft,
	holdUserState,
	keyCode,
	keystroke,
	mawokPids,
	openSettings,
	pressInSettings,
	pressTrayMenuItem,
	processesMatching,
	relaunchWithTestConfig,
	restoreUserState,
	runAction,
	setClipboard,
	showDraftWith,
	waitDraftValue,
	watchLog,
	windowElements
} from '../lib/macos.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';

// コマンドのアクションを macOS で見る。コマンドを渡すシェル (ログインシェル) と、止めるときにプロセスの
// グループごと止める作りが OS ごとに別なので、Windows の E2E (tests/actions-command.test.mjs) とは別に見る。
// ログに書かないこと (27.) も、失敗の見分け (終了コード 127 を「見つからない」とする等) が macOS の側の作りなので見る。
// 設定のコマンドの欄の Enter と貼り付け (21.) は、文字の入力を WKWebView が受けるので見る。
// アクションは、絞り込みに名前を打って選ぶので、名前を英数にする。AI のアクションは本物の AI サービスへ
// 送ってしまうので置かない

const STAMP = Date.now();
// 「出さない」のアクションが追記するファイル
const APPEND_FILE = path.join(os.tmpdir(), `mawok-macos-actions-${STAMP}.txt`);
// sleep の秒数は、ほかで動いている sleep と見分けるため、ありそうにない数にする
const CANCEL_SLEEP = 'sleep 31.7';
const QUIT_SLEEP = 'sleep 61.7';
const INSERTED = '<D>';

/** 設定ファイルの [[actions]] の1件。値は TOML の文字列に書く */
const action = (name, command, output = 'replace') =>
	`[[actions]]\nname = ${JSON.stringify(name)}\ncommand = ${JSON.stringify(command)}\noutput = "${output}"\n`;

const ACTIONS = [
	action('upper', 'tr a-z A-Z'),
	action('wait', `${CANCEL_SLEEP}; cat`),
	action('missing', 'mawok-no-such-command'),
	action('fail', 'echo oops >&2; exit 3'),
	action('silent', 'cat >/dev/null'),
	action('args', "printf '[%s]' {{t}}"),
	action('insert', `printf '${INSERTED}'`, 'insert'),
	action('record', `cat >> '${APPEND_FILE}'`, 'none'),
	action('quitwait', `${QUIT_SLEEP}; cat`)
].join('');

const CONFIG = `language = "ja"\nai_service = "none"\n${ACTIONS}`;

// 下書きは、日本語や改行を打てないので、どれも貼り付けて書く (showDraftWith の paste)

/** 失敗の帯の文 (見出しの「実行できませんでした」の後ろに続く理由)。出ていなければ null */
async function readAlert() {
	const texts = await draftTexts();
	const heading = texts.indexOf('実行できませんでした');
	return heading < 0 ? null : (texts[heading + 1] ?? '');
}

const waitAlert = (label) => waitFor(readAlert, (alert) => alert !== null, { label });

/** 入力欄の下の知らせ (実行している間・終わった後)。出ていなければ null */
async function readStatus() {
	return (await draftTexts()).find((text) => /を実行(しています|しました)/.test(text)) ?? null;
}

const draftValue = async () => (await draftState()).value;

/** 下書きを隠す (次のテストを、空でない書きかけから始めないよう、中身を消してから) */
async function clearAndHideDraft() {
	await keystroke('a', ['command down']);
	await keyCode(KEY.delete);
	await hideDraft();
}

test.describe('macOS: コマンドのアクション', () => {
	let log;

	test.before(async () => {
		await holdUserState();
		log = watchLog();
		await relaunchWithTestConfig(CONFIG, { clearHistory: true });
	});

	test.after(async () => {
		await restoreUserState();
		await fs.rm(APPEND_FILE, { force: true });
	});

	test('コマンドの結果で下書きが置き換わり、入力欄にフォーカスがある (23.)', async () => {
		await showDraftWith('hello mawok', { paste: true });
		await runAction('upper');
		await waitDraftValue('HELLO MAWOK');
		assert.equal((await draftState()).focusedRole, 'AXTextArea', '入力欄にフォーカスがある');
		await clearAndHideDraft();
	});

	test('実行している間に Esc で取り消すと、すぐ元の文のまま書き換えられる状態に戻り、コマンドが残らない (24.)', async () => {
		await showDraftWith('abc', { paste: true });
		await runAction('wait');
		await waitFor(readStatus, (status) => status?.startsWith('waitを実行しています'), {
			label: '実行している間の知らせ'
		});
		await waitFor(
			() => processesMatching(CANCEL_SLEEP),
			(pids) => pids.length > 0,
			{ label: 'sleep が動き出す' }
		);
		await keystroke('x');
		await expectStays(draftValue, 'abc', {
			label: '実行している間は書き換えられない',
			duration: 500
		});

		await keyCode(KEY.escape);
		await waitFor(readStatus, (status) => status === null, {
			label: '取り消すと知らせが消える',
			timeout: 1000
		});
		await keystroke('x');
		await waitDraftValue('abcx');
		await waitFor(
			() => processesMatching(CANCEL_SLEEP),
			(pids) => pids.length === 0,
			{ label: 'sleep が残らない', timeout: 3000 }
		);
		await clearAndHideDraft();
	});

	test('見つからないコマンドは、見つからなかった旨とシェルの標準エラーを帯に出す (25.)', async () => {
		await showDraftWith('abc', { paste: true });
		await runAction('missing');
		const alert = await waitAlert('失敗の帯');
		assert.ok(alert.startsWith('コマンドが見つかりませんでした。'), alert);
		assert.ok(alert.includes('command not found: mawok-no-such-command'), alert);
		assert.equal(await draftValue(), 'abc');
		await clearAndHideDraft();
	});

	test('失敗したコマンドの終了コードと標準エラー、何も返さないコマンドを帯に出し、下書きは変わらない (26.)', async () => {
		await showDraftWith('abc', { paste: true });
		await runAction('fail');
		const failed = await waitAlert('終了コード 3 の帯');
		assert.ok(failed.includes('終了コード 3'), failed);
		assert.ok(failed.includes('oops'), failed);

		await runAction('silent');
		const empty = await waitFor(readAlert, (alert) => alert?.includes('何も返りませんでした'), {
			label: '何も返らない帯'
		});
		assert.ok(empty);
		assert.equal(await draftValue(), 'abc');
		await clearAndHideDraft();
	});

	test('下書きの全体が、記号も改行もそのまま1つの引数で渡る (28.)', async () => {
		const text = 'a "b" \\ c; echo x\n$HOME %PATH% !x!';
		await showDraftWith(text, { paste: true });
		await runAction('args');
		await waitDraftValue(`[${text}]`);
		await clearAndHideDraft();
	});

	test('「挿入」は、カーソルの位置と選んだ範囲の後ろに入れ、下書きが空でも実行できる (29.)', async () => {
		await showDraftWith('abcdef', { paste: true });
		for (let i = 0; i < 3; i++) await keyCode(KEY.left);
		await runAction('insert');
		await waitDraftValue(`abc${INSERTED}def`);

		await showDraftWith('abcdef', { paste: true });
		// 末尾から3つ戻って、左へ2文字選ぶ (bc)
		for (let i = 0; i < 3; i++) await keyCode(KEY.left);
		for (let i = 0; i < 2; i++) await keyCode(KEY.left, ['shift down']);
		await runAction('insert');
		await waitDraftValue(`abc${INSERTED}def`);

		await showDraftWith('', { paste: true });
		await runAction('insert');
		await waitDraftValue(INSERTED);
		await clearAndHideDraft();
	});

	test('「出さない」は、下書きを変えず、実行したことだけを知らせて消え、コマンドには下書きが渡る (30.)', async () => {
		const text = `mawok-macos-${STAMP}`;
		await showDraftWith(text, { paste: true });
		await runAction('record');
		await waitFor(readStatus, (status) => status === 'recordを実行しました', {
			label: '実行したことの知らせ'
		});
		assert.equal(await draftValue(), text);
		await waitFor(readStatus, (status) => status === null, {
			label: '知らせが消える',
			timeout: 10_000
		});
		const written = await fs.readFile(APPEND_FILE, 'utf8');
		assert.ok(written.includes(text), written);
		await clearAndHideDraft();
	});

	test('絞り込みの欄に書いたコマンドを、登録しなくても実行できる (31.)', async () => {
		await showDraftWith('abc', { paste: true });
		await runAction('wc -l', 'この内容で実行');
		await waitFor(draftValue, (value) => value.trim() === '1', {
			label: '行の数で置き換わった下書き'
		});
		await clearAndHideDraft();
	});

	test('ログには、コマンドの行・渡した文・出力を書かず、番号と失敗の種類、終了コードだけを残す (27.)', async () => {
		const written = log();
		for (const secret of [
			'mawok-no-such-command',
			'tr a-z',
			'hello mawok',
			'oops',
			CANCEL_SLEEP,
			`mawok-macos-${STAMP}`,
			'wc -l'
		]) {
			assert.equal(written.includes(secret), false, `ログに「${secret}」があってはいけない`);
		}
		assert.match(written, /action \d+ started \(command\)/);
		assert.match(written, /action \d+ failed: .*3/);
	});

	test('設定で足すと、コマンドの欄と結果の出し方が出て、コマンドの欄の Enter では改行が入らず、貼り付けた改行は残る (21.)', async () => {
		await openSettings('アクション', '既定のアクションを追加');
		await pressInSettings('AXButton', '追加');
		const commandValue = async () =>
			(await windowElements(SETTINGS_TITLE)).findLast(
				({ role, name }) => role === 'AXTextArea' && name === 'コマンド'
			)?.value ?? null;
		const elements = await waitFor(
			() => windowElements(SETTINGS_TITLE),
			(current) => current.some(({ role, name }) => role === 'AXTextArea' && name === 'コマンド'),
			{ label: '足した行のコマンドの欄' }
		);
		assert.deepEqual(
			elements
				.filter(({ role }) => role === 'AXRadioButton')
				.map(({ name }) => name)
				.slice(-3),
			['置換', '挿入', '出さない'],
			'結果の出し方の選択'
		);

		await focusWindowElement(SETTINGS_TITLE, 'AXTextArea', 'コマンド');
		await keyCode(KEY.eisu);
		await keystroke('echo hi');
		await waitFor(commandValue, (value) => value === 'echo hi', { label: '打ったコマンド' });
		await keyCode(KEY.return);
		await expectStays(commandValue, 'echo hi', {
			label: 'Enter で改行が入らない',
			duration: 500
		});
		await keystroke('a', ['command down']);
		await setClipboard('echo 1\necho 2');
		await keystroke('v', ['command down']);
		await waitFor(commandValue, (value) => value === 'echo 1\necho 2', {
			label: '貼り付けた2行'
		});
		await closeSettings();
	});

	test('既定の「行を並べ替え」で、日本語を含む行が並べ替わる', async () => {
		// アクションを書かない設定で起動すると、既定のアクションになる
		await relaunchWithTestConfig('language = "ja"\nai_service = "none"\n');
		await showDraftWith('うめ\nあんず\nいちご', { paste: true });
		await runAction('sort', '行を並べ替え ');
		await waitDraftValue('あんず\nいちご\nうめ');
		await clearAndHideDraft();
	});

	test('実行している間にメニューバーから終了すると、コマンドが残らない (32.)', async () => {
		await relaunchWithTestConfig(CONFIG);
		await showDraftWith('abc', { paste: true });
		await runAction('quitwait');
		await waitFor(
			() => processesMatching(QUIT_SLEEP),
			(pids) => pids.length > 0,
			{ label: 'sleep が動き出す' }
		);
		await pressTrayMenuItem(TRAY_MENU_JA.quit);
		await waitFor(mawokPids, (pids) => pids.length === 0, {
			label: 'メニューの「終了」で終わる',
			timeout: 10_000
		});
		await waitFor(
			() => processesMatching(QUIT_SLEEP),
			(pids) => pids.length === 0,
			{ label: 'sleep が残らない', timeout: 3000 }
		);
	});
});
