import test from 'node:test';
import assert from 'node:assert/strict';
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
	listBrokenConfigCopies,
	readBrokenConfigCopy,
	readConfigText,
	removeBrokenConfigCopy,
	toConfigText,
	tryReadConfig,
	writeConfigText
} from '../lib/config.mjs';
import { waitFor } from '../lib/wait.mjs';

// 再起動と設定ファイル。設定の変更は、設定画面の表の操作 (部品テストで見ている) ではなく、
// 設定画面と同じコマンドで行う。起動した後の設定は、画面が読むのと同じ get_settings で読む。
// トレイに出る警告の文言は、トレイのメニューの、選べない「⚠ …」の項目で見る (`lib.rs` の tray_menu)。
// エクスプローラーで設定ファイルを表示する (2.) は見ない

const suite = createSuite();
const REPLACEMENTS = [{ from: 'E2E前', to: 'E2E後', enabled: true }];

test.describe('再起動と設定ファイル', () => {
	let testConfig;
	let client;
	/** トレイのメニューを出したアプリのプロセス ID (後始末で、残ったメニューを閉じるために持つ) */
	let trayPid;
	/** テストの前からあった config.broken-….toml (テストが作らせたものだけを消すため) */
	let brokenCopiesBefore;

	test.before(async () => {
		await suite.before();
		// 警告の文言は Rust 側が表示言語から作る (`i18n.rs`) ので、日本語に固定する
		testConfig = await beginTestConfig({ language: 'ja' });
		brokenCopiesBefore = await listBrokenConfigCopies();
	});
	test.after(async () => {
		try {
			// 前からあった一覧を取れていなければ、ユーザーの写しを消してしまわないよう何も消さない
			if (brokenCopiesBefore !== undefined) {
				for (const name of await listBrokenConfigCopies()) {
					if (!brokenCopiesBefore.includes(name)) await removeBrokenConfigCopy(name);
				}
			}
		} finally {
			// ログイン時の起動の登録は、直接回すときは suite.after が書き戻す (`just e2e` では run.mjs が書き戻す)
			try {
				await testConfig?.restore();
			} finally {
				await suite.after();
			}
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

	/** トレイのメニューに出ている警告 (選べない「⚠ …」の項目) の文言 */
	async function readTrayWarnings() {
		const pid = await getMawokProcessId();
		// 閉じ損ねたときに afterEach が閉じられるよう、開ける前に控えておく
		trayPid = pid;
		const { hwnd } = await openTrayMenu(pid);
		try {
			const items = await readTrayMenu(hwnd);
			return items
				.filter((item) => !item.separator && !item.enabled)
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

	test('TOML として読めない設定ファイルでは既定の設定で動き、ファイルは書き換えない', async () => {
		const broken = `hotkey = "${OTHER_HOTKEY}"\ntheme = "dark"\nlanguage = \n`;
		await writeConfigText(broken);

		const settings = await launch();
		assert.equal(settings.hotkey, DEFAULT_HOTKEY, 'ホットキーは既定のはず');
		assert.equal(settings.theme, 'system', 'テーマは既定のはず');
		await sendHotkeyAsKeyInput();
		await waitDraftVisible('既定のホットキーで下書きが出る');
		assert.equal(await readConfigText(), broken, '起動しただけでは設定ファイルを書き換えないはず');

		// TOML として読めないと language も読めないので、文言の言語は OS の地域と言語に従う。
		// ここは日本語環境が前提 (e2e/README.md の前提を参照)
		const warnings = await readTrayWarnings();
		assert.equal(warnings.length, 1, 'トレイに警告が1つ出るはず');
		assert.match(
			warnings[0],
			/^設定ファイルを読めません: /,
			'読めない設定ファイルの警告が出るはず'
		);
	});

	test('1項目だけ型を崩すとその項目だけ既定に戻り、設定を変えると元の内容が config.broken-….toml に写る', async () => {
		// 警告の文言を決め打ちできるよう、壊していない language も書いておく
		const original = toConfigText({
			hotkey: OTHER_HOTKEY,
			language: 'ja',
			theme: 1,
			replacements: REPLACEMENTS
		});
		await writeConfigText(original);
		const copiesBefore = await listBrokenConfigCopies();

		const settings = await launch();
		assert.equal(settings.theme, 'system', '型を崩したテーマは既定に戻るはず');
		assert.equal(settings.hotkey, OTHER_HOTKEY, 'ほかの項目はそのままのはず');
		assert.deepEqual(settings.replacements, REPLACEMENTS, 'ほかの項目はそのままのはず');
		await sendKeySequence([[VK.CONTROL, VK.SHIFT, VK.J]]);
		await waitDraftVisible('型を崩していないホットキーで下書きが出る');

		assert.deepEqual(
			await readTrayWarnings(),
			['設定ファイルの読めない値と重なったキーを直しました: theme'],
			'直した項目の名前が、トレイの警告に出るはず'
		);

		await invokeApp(client, 'set_theme', { theme: 'light' });
		const copies = await waitFor(
			listBrokenConfigCopies,
			(names) => names.length === copiesBefore.length + 1,
			{ label: 'config.broken-….toml ができる' }
		);
		const created = copies.find((name) => !copiesBefore.includes(name));
		assert.equal(await readBrokenConfigCopy(created), original, '写しは元の内容のはず');
		const saved = await tryReadConfig();
		assert.equal(saved?.theme, 'light');
		assert.equal(saved?.hotkey, OTHER_HOTKEY);

		assert.deepEqual(
			await readTrayWarnings(),
			[`元の設定ファイルを ${created} に写しました`],
			'トレイの警告が、写した先のファイル名の知らせに変わるはず'
		);
	});

	test('メモ帳で書いたような CRLF とコメントのファイルでも、設定画面から変えた値だけが変わりコメントは残る', async () => {
		const original = [
			'# E2E のメモ',
			`hotkey = "${DEFAULT_HOTKEY}"`,
			'language = "ja"   # 日本語で使う',
			'',
			'# 辞書',
			'[[replacements]]',
			'from = "E2E前"',
			'to = "E2E後"',
			''
		].join('\r\n');
		await writeConfigText(original);

		await launch();
		await invokeApp(client, 'set_theme', { theme: 'dark' });
		const saved = await waitFor(tryReadConfig, (config) => config?.theme === 'dark', {
			label: '設定ファイルのテーマが変わる'
		});
		assert.equal(saved.language, 'ja');
		assert.deepEqual(saved.replacements, REPLACEMENTS);

		const text = await readConfigText();
		assert.match(text, /# E2E のメモ/, '先頭のコメントが残るはず');
		assert.ok(text.includes('language = "ja"   # 日本語で使う'), '値の後ろのコメントが残るはず');
		assert.match(text, /# 辞書/, '表の前のコメントが残るはず');
	});
});
