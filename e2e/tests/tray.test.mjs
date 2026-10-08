import test from 'node:test';
import assert from 'node:assert/strict';
import { MANUAL_TITLE, SETTINGS_TITLE, TRAY_MENU_JA } from '../lib/app-conf.mjs';
import { createSuite } from '../lib/setup.mjs';
import {
	expectDraftStaysHidden,
	invokeApp,
	readDraft,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitDraftHidden,
	waitDraftVisible,
	waitForWindowCount,
	waitSettingsWindow
} from '../lib/app.mjs';
import {
	findVisibleMawokWindow,
	getClipboard,
	getDraftWindowHandle,
	getForegroundWindowHandle,
	getMawokProcessId,
	isDraftWindowVisible,
	isMawokRunning,
	setClipboard
} from '../lib/os.mjs';
import {
	clickTrayMenuItem,
	closeLeftoverTrayMenu,
	closeTrayMenu,
	closeTrayOverflow,
	openTrayMenu,
	readTrayMenu
} from '../lib/tray.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import { launchPasteTarget } from '../lib/paste-target.mjs';
import { isWindowAbove } from '../lib/window.mjs';
import { waitFor } from '../lib/wait.mjs';

// トレイ。アイコンを押してメニューを出し、「テキストウィンドウを表示／隠す」「設定…」
// 「使い方」「終了」がそれぞれ効くことと、「テキストウィンドウを表示／隠す」に今のホットキーが添えてあることを見る。
// アイコンの見た目 (届いた下書きの点) は人の目で見るものなので手に残す。
//
// アイコンは、タスクバーに常設で出ていることも、「非表示のアイコン」の中に入っていることもある。
// どちらでも動くよう `lib/tray.mjs` が両方を見るので、このテストは置き場所を決め打ちしない。
// macOS のメニューバーは別の作りなので、ここで見ているのは Windows の作りだけ

const suite = createSuite();
// muda が Windows でアクセラレーターを文字にした形 (DEFAULT_HOTKEY の CommandOrControl+Shift+Space)
const DEFAULT_HOTKEY_TEXT = 'Ctrl+Shift+Space';
const SENTINEL = 'e2e-sentinel-before';

test.describe('トレイ', () => {
	let testConfig;
	let client;
	let pid;

	test.before(async () => {
		await suite.before();
		// メニューの文字列は Rust 側が表示言語から作る (`i18n.rs`) ので、日本語に固定する
		testConfig = await beginTestConfig({ language: 'ja', hideTextWindowOnBlur: true });
	});
	test.after(async () => {
		try {
			await testConfig?.restore();
		} finally {
			await suite.after();
		}
	});

	test.beforeEach(async () => {
		// 起動に失敗したときに、前のテストのプロセス ID を使い回さない
		pid = null;
		client = await suite.newClient();
		pid = await getMawokProcessId();
	});
	test.afterEach(async () => {
		try {
			// 落ちたテストがメニューを出したままにしないよう、残っていれば閉じる。
			// ここは投げないので、下のフライアウトの後始末に必ず進む
			await closeLeftoverTrayMenu(pid);
			// メニューを出すために開いた「非表示のアイコン」は Explorer 側のもので、メニューを閉じても
			// 開いたまま残るので、ここで閉じる。開いていなければ何もしない。
			// 上の closeLeftoverTrayMenu と違って握りつぶさないのは、閉じられないことが次のテストに響くため。
			// 開いたままだと次の openTrayMenu が押して逆に閉じるので、ここで鳴らさないと、
			// 原因から離れた場所で落ちる
			await closeTrayOverflow();
		} finally {
			await suite.closeClient(client);
		}
	});

	test('アイコンを押すと、「テキストウィンドウを表示／隠す」「設定…」「使い方」「終了」のメニューが出る', async () => {
		const { hwnd, where } = await openTrayMenu(pid);
		try {
			// タスクバーに常設で出ていても、「非表示のアイコン」の中にいても押せること
			assert.ok(
				where === 'taskbar' || where === 'overflow',
				`アイコンの置き場所は taskbar か overflow のはず (実際: ${where})`
			);
			const items = await readTrayMenu(hwnd);
			assert.deepEqual(
				items.filter((item) => !item.separator).map((item) => item.text),
				[TRAY_MENU_JA.toggleDraft, TRAY_MENU_JA.settings, TRAY_MENU_JA.manual, TRAY_MENU_JA.quit],
				'区切り線を除くと、この4つが並ぶはず'
			);
			assert.deepEqual(
				items.filter((item) => !item.separator).map((item) => item.accelerator),
				[DEFAULT_HOTKEY_TEXT, '', '', ''],
				'「テキストウィンドウを表示／隠す」の右端にだけ、今のホットキーが添えてあるはず'
			);
			assert.ok(
				items.some((item) => item.separator),
				'区切り線があるはず'
			);
			assert.deepEqual(
				items.filter((item) => !item.separator).map((item) => item.enabled),
				[true, true, true, true],
				'4つとも選べるはず'
			);
		} finally {
			await closeTrayMenu(pid);
		}
	});

	test('隠れているときに「テキストウィンドウを表示／隠す」を押すと、下書きが出て前面になる', async () => {
		assert.equal(await isDraftWindowVisible(), false, '起動した直後は下書きは隠れているはず');

		const { hwnd } = await openTrayMenu(pid);
		await clickTrayMenuItem(hwnd, TRAY_MENU_JA.toggleDraft);

		await waitDraftVisible('トレイの「テキストウィンドウを表示／隠す」で出る下書き');
		const draftHwnd = await getDraftWindowHandle();
		await waitFor(getForegroundWindowHandle, (handle) => handle === draftHwnd, {
			label: '出た下書きが前面になる'
		});
	});

	test('アプリの上でトレイから出した下書きを Esc で隠すと、そのアプリへフォーカスが戻る', async () => {
		const appA = await launchPasteTarget({ title: 'Mawok E2E アプリ A' });
		try {
			await appA.activate();
			// メニューを出すと、前面は Mawok の見えないトレイのウィンドウ (tray_icon_app) に移る。
			// それを戻り先にすると、Esc の後にどこにも打てなくなる
			const { hwnd } = await openTrayMenu(pid);
			await clickTrayMenuItem(hwnd, TRAY_MENU_JA.toggleDraft);
			await waitDraftVisible('トレイの「テキストウィンドウを表示／隠す」で出る下書き');
			const draftHwnd = await getDraftWindowHandle();
			await waitFor(getForegroundWindowHandle, (handle) => handle === draftHwnd, {
				label: '出た下書きが前面になる'
			});

			await sendKeySequence([[VK.ESCAPE]]);
			await waitDraftHidden('Esc で隠れる下書き');
			await appA.waitForeground('Esc の後、トレイを押す前のアプリ (A) へのフォーカスの戻り');
		} finally {
			await appA.close();
		}
	});

	test('出ているときに「テキストウィンドウを表示／隠す」を押すと、コピーせずに隠れ、ほかのアプリから前面を奪わない', async () => {
		let appA;
		let appB;
		try {
			// オンだと、アイコンを押した時点で (下書きからフォーカスが外れて) 隠れてしまい、
			// 押して隠れたのかを見分けられない
			await invokeApp(client, 'set_hide_draft_on_blur', { enabled: false });
			// A の上で下書きを出し、B に移ってからトレイで隠す。隠したときに戻り先の A を前に出さないことを見る
			appA = await launchPasteTarget({ title: 'Mawok E2E アプリ A', left: 40, top: 40 });
			appB = await launchPasteTarget({ title: 'Mawok E2E アプリ B', left: 560, top: 320 });
			await appA.activate();
			await setClipboard(SENTINEL);
			await showDraftAndWaitVisible();
			const text = `e2e tray toggle ${Date.now()}`;
			await typeIntoDraft(client, text);
			await appB.activate();
			assert.equal(await isDraftWindowVisible(), true, 'オフなので、B に移っても出たままのはず');

			const { hwnd } = await openTrayMenu(pid);
			await clickTrayMenuItem(hwnd, TRAY_MENU_JA.toggleDraft);

			await waitDraftHidden('トレイの「テキストウィンドウを表示／隠す」で隠れる下書き');
			// 隠したときに戻り先 (A) へフォーカスを戻すと前面を奪うので、しばらく見る。
			// 前面は B ではなく、アイコンを押した時点で Mawok のトレイのウィンドウ (tray_icon_app) に移っている。
			// そこで、前面が A でないことに加えて、重なり順でも A が B の前に出てこないことを見る
			await new Promise((resolve) => setTimeout(resolve, 500));
			assert.notEqual(
				await getForegroundWindowHandle(),
				appA.hwnd,
				'下書きを出したときのアプリ (A) が前に出てこないはず'
			);
			assert.ok(
				await isWindowAbove(appB.hwnd, appA.hwnd),
				'重なり順でも、A が B より前に出てこないはず'
			);
			assert.equal(await getClipboard(), SENTINEL, 'Esc と同じくコピーしないはず');

			await showDraftAndWaitVisible('出し直し');
			assert.equal((await readDraft(client)).value, text, '書きかけが残っているはず');
		} finally {
			// 途中で投げても残りの後始末を続けるよう、1つずつ包む
			try {
				await appA?.close();
			} finally {
				try {
					await appB?.close();
				} finally {
					// 設定ファイルに書かれ、このファイルのほかのテスト (起動し直す) に残るので戻す
					await invokeApp(client, 'set_hide_draft_on_blur', { enabled: true });
				}
			}
		}
	});

	test('「設定…」で設定ウィンドウが出る', async () => {
		const { hwnd } = await openTrayMenu(pid);
		await clickTrayMenuItem(hwnd, TRAY_MENU_JA.settings);

		await waitForWindowCount(client, 2);
		const settingsHwnd = await waitFor(
			() => findVisibleMawokWindow(SETTINGS_TITLE),
			(found) => found !== null,
			{ label: 'トレイの「設定…」で出る設定ウィンドウ' }
		);
		await waitFor(getForegroundWindowHandle, (handle) => handle === settingsHwnd, {
			label: '出た設定ウィンドウが前面になる'
		});

		// 次のテストに持ち越さないよう閉じる
		await sendKeySequence([[VK.ESCAPE]]);
		await waitForWindowCount(client, 1);
	});

	test('「使い方」で使い方のウィンドウが出て前面になり、Esc で閉じる', async () => {
		const { hwnd } = await openTrayMenu(pid);
		await clickTrayMenuItem(hwnd, TRAY_MENU_JA.manual);

		await waitForWindowCount(client, 2);
		const manualHwnd = await waitFor(
			() => findVisibleMawokWindow(MANUAL_TITLE),
			(found) => found !== null,
			{ label: 'トレイの「使い方」で出る使い方のウィンドウ' }
		);
		await waitFor(getForegroundWindowHandle, (handle) => handle === manualHwnd, {
			label: '出た使い方のウィンドウが前面になる'
		});

		await sendKeySequence([[VK.ESCAPE]]);
		await waitForWindowCount(client, 1);
	});

	test('下書きを出したままトレイから設定を開くと、アイコンを押した時点で下書きが隠れ、設定を閉じても出てこない', async () => {
		await showDraftAndWaitVisible();
		const [draftHandle] = await client.getWindowHandles();
		const { hwnd } = await openTrayMenu(pid);
		// 「ほかのアプリに移ったら下書きウィンドウを隠す」がオンなので、アイコンを押して下書きからフォーカスが外れた時点で隠れる
		await waitDraftHidden('トレイのアイコンを押して隠れる下書き');
		await clickTrayMenuItem(hwnd, TRAY_MENU_JA.settings);
		// 前面になる前の Esc は、設定ウィンドウに届かない
		await waitSettingsWindow(client, draftHandle);

		await sendKeySequence([[VK.ESCAPE]]);
		await waitForWindowCount(client, 1);
		await expectDraftStaysHidden('設定を閉じた後');
	});

	test('隠れずに出たままの下書きは、トレイから設定を開くと隠れ、設定を閉じると出し直される', async () => {
		try {
			// オフにすると、トレイのアイコンを押しても下書きは出たまま
			await invokeApp(client, 'set_hide_draft_on_blur', { enabled: false });
			await showDraftAndWaitVisible();
			const text = `e2e tray settings ${Date.now()}`;
			await typeIntoDraft(client, text);
			const [draftHandle] = await client.getWindowHandles();
			const { hwnd } = await openTrayMenu(pid);
			assert.equal(
				await isDraftWindowVisible(),
				true,
				'アイコンを押しても、下書きは出たままのはず'
			);
			await clickTrayMenuItem(hwnd, TRAY_MENU_JA.settings);
			await waitDraftHidden('設定を開くと隠れる下書き');
			await waitSettingsWindow(client, draftHandle);

			await sendKeySequence([[VK.ESCAPE]]);
			await waitForWindowCount(client, 1);
			await waitDraftVisible('設定を閉じると出し直される下書き');
			assert.equal((await readDraft(client)).value, text, '書きかけが残っているはず');
		} finally {
			await invokeApp(client, 'set_hide_draft_on_blur', { enabled: true });
		}
	});

	test('「終了」で終了する', async () => {
		const { hwnd } = await openTrayMenu(pid);
		await clickTrayMenuItem(hwnd, TRAY_MENU_JA.quit);

		// 終了するとこのテストのアプリは消える。afterEach の closeClient は、
		// 切れたセッションを黙って受け流し、プロセスが残っていないことだけを見る
		await waitFor(isMawokRunning, (running) => running === false, {
			label: 'トレイの「終了」で終わる',
			timeout: 10000
		});
	});
});
