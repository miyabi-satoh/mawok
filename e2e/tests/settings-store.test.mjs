import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSuite } from '../lib/setup.mjs';
import {
	DEFAULT_HOTKEY,
	invokeApp,
	OTHER_HOTKEY,
	sendHotkeyAsKeyInput,
	waitDraftVisible
} from '../lib/app.mjs';
import { getMawokProcessId } from '../lib/os.mjs';
import {
	closeLeftoverTrayMenu,
	closeTrayMenu,
	closeTrayOverflow,
	openTrayMenu,
	readTrayMenu
} from '../lib/tray.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import {
	beginTestConfig,
	tryReadConfig,
	readConfigBytes,
	writeConfigBytes,
	writeTestSettings
} from '../lib/config.mjs';
import { SETTINGS_FILE } from '../lib/settings-files.mjs';
import { waitFor } from '../lib/wait.mjs';

// 再起動と設定の置き場 (docs/config.md)。設定の変更は、設定画面の表の操作 (部品テストで見ている) ではなく、
// 設定画面と同じコマンドで行う。起動した後の設定は、画面が読むのと同じ get_settings で読む。
// トレイに出る警告の文言は、トレイのメニューの「⚠ …」の項目で見る (`lib.rs` の tray_menu)

const suite = createSuite();
const REPLACEMENTS = [{ from: 'E2E前', to: 'E2E後', enabled: true }];

test.describe('再起動と設定の置き場', () => {
	let testConfig;
	let client;
	/** トレイのメニューを出したアプリのプロセス ID (後始末で、残ったメニューを閉じるために持つ) */
	let trayPid;

	test.before(async () => {
		await suite.before();
		// 警告の文言は Rust 側が表示言語から作る (`i18n.rs`) ので、日本語に固定する
		testConfig = await beginTestConfig({ language: 'ja' });
	});
	test.after(async () => {
		// ログイン時の起動の登録は、直接回すときは suite.after が書き戻す (`just e2e` では run.mjs が書き戻す)
		try {
			await testConfig?.restore();
		} finally {
			await suite.after();
		}
	});

	test.afterEach(async () => {
		try {
			// Esc で閉じられなかったメニューが残っていれば、先に閉じる。残したまま次のテストに入ると、
			// 次の openTrayMenu が「すでにメニューが出ています」で落ちて、本当の原因が消える。
			// ここは投げないので、下のフライアウトの後始末に必ず進む
			await closeLeftoverTrayMenu(trayPid);
			trayPid = undefined;
			// トレイの警告を読むテストが開けた「非表示のアイコン」を閉じる。開いていなければ何もしない。
			// readTrayWarnings の finally ではなくここに置くのは、openTrayMenu 自体が落ちたときと、
			// メニューを閉じられなかったときにも掛けるため。run.mjs はファイル名順に回すので、
			// 閉じ残すと、後から回る tray.test.mjs に開いたまま持ち越される。
			// 握りつぶさない理由は tray.test.mjs と同じ
			await closeTrayOverflow();
		} finally {
			if (client) await suite.closeClient(client);
			client = undefined;
		}
	});

	async function launch() {
		client = await suite.newClient();
		return invokeApp(client, 'get_settings');
	}

	/** トレイのメニューに出ている警告 (「⚠ …」の項目) の文言 */
	async function readTrayWarnings() {
		const pid = await getMawokProcessId();
		// 閉じ損ねたときに afterEach が閉じられるよう、開ける前に控えておく
		trayPid = pid;
		const { hwnd } = await openTrayMenu(pid);
		try {
			const items = await readTrayMenu(hwnd);
			return items
				.filter((item) => !item.separator && item.text.startsWith('⚠'))
				.map((item) => item.text.replace(/^⚠\s*/, ''));
		} finally {
			// ここで落とすと、読んだ中身より先にメニューの閉じ損ねが出てしまう。
			// 閉じ残したときは afterEach が閉じる (trayPid を控えてある)
			await closeTrayMenu(pid).catch(() => {});
		}
	}

	test('変えたホットキー・テーマ・置き換え辞書は、起動し直しても残る', async () => {
		await launch();
		await invokeApp(client, 'set_hotkey', { accelerator: OTHER_HOTKEY });
		await invokeApp(client, 'set_theme', { theme: 'dark' });
		await invokeApp(client, 'set_replacements', { replacements: REPLACEMENTS });
		await suite.closeClient(client);

		const settings = await launch();
		assert.equal(settings.hotkey, OTHER_HOTKEY);
		assert.equal(settings.theme, 'dark');
		assert.deepEqual(settings.replacements, REPLACEMENTS);
		// 残ったホットキーが、起動したときに登録されている
		await sendKeySequence([[VK.CONTROL, VK.SHIFT, VK.J]]);
		await waitDraftVisible('残ったホットキーで下書きが出る');
	});

	test('TOML として読めない設定のファイルは、書き換えずに既定の設定で始め、トレイに知らせる', async () => {
		const broken = Buffer.from('theme = \n');
		await writeConfigBytes(broken);

		const settings = await launch();
		assert.equal(settings.hotkey, DEFAULT_HOTKEY, 'ホットキーは既定のはず');
		assert.equal(settings.theme, 'system', 'テーマは既定のはず');
		await sendHotkeyAsKeyInput();
		await waitDraftVisible('既定のホットキーで下書きが出る');

		// 設定を変えても、読めないファイルは書き換えない (手で書きかけのものを消さないため)
		await assert.rejects(
			invokeApp(client, 'set_theme', { theme: 'dark' }),
			/settings\.file_unreadable/
		);
		assert.deepEqual(await readConfigBytes(), broken, '読めないファイルはそのままのはず');

		// 読めないと language も読めないので、文言の言語は OS の地域と言語に従う。
		// ここは日本語環境が前提 (e2e/README.md の前提を参照)
		assert.deepEqual(
			await readTrayWarnings(),
			['設定のファイルを読めません'],
			'読めないことがトレイの警告に出るはず'
		);
	});

	test('読めない値の項目だけが既定に戻り、ほかの項目はそのまま使う', async () => {
		await writeTestSettings({
			// ログイン時の起動の登録に触れないよう、オフで起動する (beginTestConfig と同じ)
			autostart: false,
			hotkey: OTHER_HOTKEY,
			language: 'ja',
			theme: 1,
			replacements: REPLACEMENTS
		});

		const settings = await launch();
		assert.equal(settings.theme, 'system', '読めない値のテーマは既定に戻るはず');
		assert.equal(settings.hotkey, OTHER_HOTKEY, 'ほかの項目はそのままのはず');
		assert.deepEqual(settings.replacements, REPLACEMENTS, 'ほかの項目はそのままのはず');
		await sendKeySequence([[VK.CONTROL, VK.SHIFT, VK.J]]);
		await waitDraftVisible('読めたホットキーで下書きが出る');
		assert.deepEqual(await readTrayWarnings(), [], 'トレイには警告を出さないはず');

		await invokeApp(client, 'set_theme', { theme: 'light' });
		const saved = await waitFor(tryReadConfig, (config) => config?.theme === 'light', {
			label: '置き場のテーマが変わる'
		});
		assert.equal(saved.hotkey, OTHER_HOTKEY);
	});

	test('バックアップから戻すと、バックアップした時点の設定になる', async () => {
		await launch();
		await invokeApp(client, 'set_theme', { theme: 'dark' });
		assert.equal(await invokeApp(client, 'back_up_settings'), true, 'バックアップを書くはず');
		await invokeApp(client, 'set_theme', { theme: 'light' });
		const backups = await invokeApp(client, 'settings_backups');
		const darkBackup = backups.find((backup) =>
			backup.changes.some(
				(change) => change.restored.type === 'theme' && change.restored.value === 'dark'
			)
		);
		assert.ok(darkBackup, 'dark のバックアップが並ぶはず');
		await invokeApp(client, 'restore_settings_backup', { name: darkBackup.name });
		const settings = await invokeApp(client, 'get_settings');
		assert.equal(settings.theme, 'dark');
	});

	test('選んだ保存先のフォルダーが無くなると、トレイに知らせて設定を保存できず、戻すと知らせが消えて読み直す', async () => {
		// クラウドストレージのドライブが外れたときと同じく、動いている間に選んだフォルダーが無くなる。
		// 見張っているフォルダーは Windows では名前を変えられない (EPERM) ので、選ぶのはジャンクションにして、
		// それを外して無くし、作り直して戻す。中身は先のフォルダーに残る
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mawok-e2e-folder-'));
		const chosen = path.join(parent, 'settings');
		const target = path.join(parent, 'drive');
		await fs.mkdir(target);
		await fs.symlink(target, chosen, 'junction');
		try {
			// テーマは既定 (ファイルに書かない) から始める。前のテストの値が残ると、下で変えても書くものが無く、保存できたと返る
			await writeTestSettings({ autostart: false, language: 'ja' });
			await launch();
			await invokeApp(client, 'set_settings_dir', { path: chosen, useExisting: false });
			await fs.rm(chosen);

			// 無くなったことは、次に書こうとしたときに気づく
			await assert.rejects(
				invokeApp(client, 'set_theme', { theme: 'dark' }),
				/settings\.folder_unavailable/,
				'保存できなかったと返るはず'
			);
			assert.deepEqual(await readTrayWarnings(), ['設定を保存できません']);
			assert.equal(
				(await invokeApp(client, 'get_settings')).settingsProblem?.kind,
				'folderMissing'
			);

			// 無い間にほかのデバイスが書いた変更を、戻したときに読み直すことを見る
			const file = path.join(target, SETTINGS_FILE);
			await fs.writeFile(file, `theme = "light"\n${await fs.readFile(file, 'utf8')}`);
			await fs.symlink(target, chosen, 'junction');
			// 見回りは 5 秒ごと (lib.rs の wait_for_settings_dir)
			await waitFor(
				() => invokeApp(client, 'get_settings'),
				(settings) => settings.settingsProblem === null && settings.theme === 'light',
				{ label: '戻した保存先を読み直し、知らせが消える', timeout: 15_000, interval: 500 }
			);
			assert.deepEqual(await readTrayWarnings(), [], 'トレイの知らせも消えるはず');
		} finally {
			// 後のテストが選んだ保存先のまま起動しないよう、既定に戻す (device.json はファイルの終わりに戻すが、それまでの分)
			if (client) {
				await invokeApp(client, 'set_settings_dir', { path: null, useExisting: false }).catch(
					() => {}
				);
			}
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
});
