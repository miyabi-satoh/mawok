import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	clickElement,
	showDraftAndWaitVisible,
	hideDraftWithoutCopy,
	invokeApp,
	openDraftAppearanceSettings as openSettings,
	closeDraftSettings,
	readDraftColors as readDraftColorsOf,
	resolveColor as resolveColorOf,
	waitDraftHidden
} from '../lib/app.mjs';
import { SETTINGS_TITLE } from '../lib/app-conf.mjs';
import { findVisibleMawokWindow, isDraftWindowVisible, snapshotAppsTheme } from '../lib/os.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { waitFor } from '../lib/wait.mjs';
import { beginTestConfig, tryReadConfig } from '../lib/config.mjs';

// 下書きの文字色。設定画面の欄に書いた色が下書きの入力欄に当たること、
// 短い形 (#abc) を受け付けること、読めない値は知らせが出て当たらないこと、既定に戻せること、
// 案内の色は変わらないこと、起動し直しても残ることを見る。
// 色見本 (input type="color") を本物のクリックで押し、出た色選びに R・G・B を打って、欄に #rrggbb で入ることも見る。
// Windows の WebView2 で出るのは、OS のダイアログではなく WebView2 (Chromium) の色選びのポップアップで、
// UI Automation には出てこないので、キーボードで操作する (開いた直後から Tab 3回で R、4回で G、5回で B の欄)。
// テーマを「システム」にしたときは、Windows の外観 (アプリのモード) を切り替えて、ライトとダークの色が入れ替わることを見る
// (lib/os.mjs の snapshotAppsTheme。切り替えた外観は、終わったら・中断されたら元に戻す)。
//
// 色は getComputedStyle で読む。oklch のまま返る値と #rrggbb を直に比べられないので、
// 同じ画面に作った要素にその色を当てて、解決した後の値どうしで比べる (lib/app.mjs の resolveColor)。
// 設定ウィンドウを出している間は WebView2 が下書きの描画を止めるので、色を読むのは設定を閉じた後に行う

const suite = createSuite();

test.describe('下書きの文字色', () => {
	let testConfig;
	let client;

	test.before(async () => {
		await suite.before();
		// 文字色と表示言語・テーマは、このテストが決め打ちするので固定する。
		// 案内も既定に戻す (ユーザーが空にしていると placeholder 属性が付かず、
		// `::placeholder` の色を読むところが落ちる。`src/routes/+page.svelte` の placeholder)
		testConfig = await beginTestConfig({
			language: 'ja',
			theme: 'light',
			inputGuidance: null,
			textColorLight: '',
			textColorDark: ''
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
	});
	test.afterEach(async () => {
		await suite.closeClient(client);
	});

	const openDraftAppearanceSettings = () => openSettings(client, '#draft-text-color-light');
	const closeSettings = (draftHandle) => closeDraftSettings(client, draftHandle);

	/** 下書きの入力欄の色を読む (このファイルでは client を使い回すので、渡さずに呼べるようにする) */
	const readDraftColors = () => readDraftColorsOf(client);
	/** 画面の中で `value` を解決した後の色 (テストが期待する色を、同じ物差しに揃えるため) */
	const resolveColor = (value) => resolveColorOf(client, value);

	test('短い形 (#abc) を受け付け、下書きの文字色に当たる。案内の色は変わらない', async () => {
		const draftHandle = await openDraftAppearanceSettings();
		await client.$('#draft-text-color-light').setValue('#abc');

		// 欄に打つたびに保存される実装なので、閉じなくても config.toml に揃った形で書かれる
		const config = await waitFor(tryReadConfig, (cfg) => cfg?.textColorLight === '#aabbcc', {
			label: 'config.toml の textColorLight'
		});
		assert.equal(config.textColorLight, '#aabbcc', '#abc は #aabbcc に揃うはず');

		await closeSettings(draftHandle);
		// 設定の反映は settings-changed のイベントで非同期に届くので、変わるまで待つ
		const expected = await resolveColor('#aabbcc');
		const colors = await waitFor(readDraftColors, (current) => current.text === expected, {
			label: '下書きの文字色 (#abc を書いた後)'
		});
		assert.equal(colors.text, expected, '下書きの文字が選んだ色になるはず');
		assert.equal(
			colors.guidance,
			colors.guidanceVariable,
			'案内の色は、文字色を変えても案内の色のままのはず'
		);
	});

	test('テーマをダークにすると、ダークの欄の色になる', async () => {
		// 色とテーマを変えた後で落ちても、後のテストに漏れないよう、変えるところから try の中に入れる
		try {
			await invokeApp(client, 'set_draft_text_color', { light: '#112233', dark: '#445566' });
			await invokeApp(client, 'set_theme', { theme: 'dark' });
			await showDraftAndWaitVisible();
			const dark = await resolveColor('#445566');
			const colors = await waitFor(readDraftColors, (current) => current.text === dark, {
				label: '下書きの文字色 (ダーク)'
			});
			assert.equal(colors.text, dark);
		} finally {
			await invokeApp(client, 'set_theme', { theme: 'light' });
			await invokeApp(client, 'set_draft_text_color', { light: '', dark: '' });
		}
	});

	test('色見本を押すと色選びが出て、選んだ色が欄に #rrggbb で入り、下書きに当たる', async () => {
		try {
			const draftHandle = await openDraftAppearanceSettings();
			const settingsHwnd = await findVisibleMawokWindow(SETTINGS_TITLE);
			await clickElement(
				client,
				settingsHwnd,
				await client.$('input[type="color"][aria-label="ライトの文字色を選ぶ"]')
			);
			// ポップアップが出てフォーカスが移るまで待つ (出たことは UI Automation からは見えない)
			await new Promise((resolve) => setTimeout(resolve, 800));
			// R・G・B の欄は 10 進で打つ。0x12・0x34・0x56
			const typeNumber = (text) =>
				sendKeySequence([[VK.CONTROL, VK.A], ...[...text].map((digit) => [digit.charCodeAt(0)])]);
			await sendKeySequence([[VK.TAB], [VK.TAB], [VK.TAB]]);
			await typeNumber('18');
			await sendKeySequence([[VK.TAB]]);
			await typeNumber('52');
			await sendKeySequence([[VK.TAB]]);
			await typeNumber('86');
			await sendKeySequence([[VK.ENTER]]);

			const field = await client.$('#draft-text-color-light');
			await waitFor(
				() => field.getValue(),
				(value) => value === '#123456',
				{ label: '色選びで選んだ色が入る欄' }
			);
			await waitFor(tryReadConfig, (cfg) => cfg?.textColorLight === '#123456', {
				label: 'config.toml の textColorLight (色選びの後)'
			});

			await closeSettings(draftHandle);
			const expected = await resolveColor('#123456');
			await waitFor(readDraftColors, (current) => current.text === expected, {
				label: '下書きの文字色 (色選びの後)'
			});
		} finally {
			await invokeApp(client, 'set_draft_text_color', { light: '', dark: '' });
		}
	});

	test('テーマを「システム」にすると、Windows の外観を切り替えたときにライトとダークの色が入れ替わる', async () => {
		const appsTheme = await snapshotAppsTheme();
		try {
			await invokeApp(client, 'set_draft_text_color', { light: '#112233', dark: '#445566' });
			await invokeApp(client, 'set_theme', { theme: 'system' });
			if (!(await isDraftWindowVisible())) await showDraftAndWaitVisible();
			const light = await resolveColor('#112233');
			const dark = await resolveColor('#445566');

			await appsTheme.set(true);
			await waitFor(readDraftColors, (current) => current.text === light, {
				label: '下書きの文字色 (Windows の外観がライト)'
			});
			await appsTheme.set(false);
			await waitFor(readDraftColors, (current) => current.text === dark, {
				label: '下書きの文字色 (Windows の外観がダーク)'
			});
			await appsTheme.set(true);
			await waitFor(readDraftColors, (current) => current.text === light, {
				label: '下書きの文字色 (Windows の外観をライトに戻した後)'
			});
		} finally {
			await appsTheme.restore();
			await invokeApp(client, 'set_theme', { theme: 'light' });
			await invokeApp(client, 'set_draft_text_color', { light: '', dark: '' });
		}
	});

	test('色として読めない値は、知らせが出て下書きの文字色に当たらない', async () => {
		// 前のテストが何を残していても左右されないよう、始めの色をこのテストで決める。
		// 空から始めると「保存されなかった」のか「もともと空だった」のか見分けられない
		await invokeApp(client, 'set_draft_text_color', { light: '#123456', dark: '' });
		try {
			await waitFor(tryReadConfig, (cfg) => cfg?.textColorLight === '#123456', {
				label: 'config.toml の textColorLight (読めない値を打つ前)'
			});
			const draftHandle = await openDraftAppearanceSettings();
			await client.$('#draft-text-color-light').setValue('red');

			const input = await client.$('#draft-text-color-light');
			await waitFor(
				() => input.getAttribute('aria-invalid'),
				(value) => value === 'true',
				{
					label: '読めない値の印 (aria-invalid)'
				}
			);
			const notice = await client.$('//*[contains(text(), "色として読めません")]');
			assert.ok(await notice.isDisplayed(), '欄の下に知らせが出るはず');
			assert.equal(
				(await tryReadConfig())?.textColorLight,
				'#123456',
				'読めない値は保存せず、打つ前の色のままのはず'
			);

			await closeSettings(draftHandle);
			const expected = await resolveColor('#123456');
			const colors = await waitFor(readDraftColors, (current) => current.text === expected, {
				label: '下書きの文字色 (読めない値を打った後)'
			});
			assert.equal(colors.text, expected, '下書きの文字色は打つ前のままのはず');
		} finally {
			await invokeApp(client, 'set_draft_text_color', { light: '', dark: '' });
		}
	});

	test('欄を空にすると、文字色が標準に戻る', async () => {
		// このテストでダークは使わないので置かない (置きっぱなしにすると後のテストに漏れる)
		await invokeApp(client, 'set_draft_text_color', { light: '#aabbcc', dark: '' });
		try {
			// 空にした後に「標準の色になった」ことだけを見ると、そもそも当たっていなくても通ってしまう。
			// 空にする前に、当てた色が下書きに来ていて、標準の色とも違うことを見ておく
			if (!(await isDraftWindowVisible())) await showDraftAndWaitVisible();
			const applied = await resolveColor('#aabbcc');
			const before = await waitFor(readDraftColors, (current) => current.text === applied, {
				label: '下書きの文字色 (空にする前)'
			});
			assert.notEqual(
				applied,
				before.foreground,
				'空にする前に当てた色が標準の文字色と同じでは、戻ったことを見分けられない'
			);

			const draftHandle = await openDraftAppearanceSettings();

			// setValue('') は input イベントを出さず保存されないので、実際のキー操作で空にする
			await client.$('#draft-text-color-light').click();
			await client.keys(['Control', 'a']);
			await client.keys(['Backspace']);

			await waitFor(tryReadConfig, (cfg) => cfg?.textColorLight === '', {
				label: 'config.toml の textColorLight (空にした後)'
			});
			assert.equal(await client.$('#draft-text-color-light').getValue(), '', '欄は空になるはず');

			await closeSettings(draftHandle);
			const colors = await waitFor(
				readDraftColors,
				(current) => current.text === current.foreground,
				{
					label: '下書きの文字色 (空にした後)'
				}
			);
			assert.equal(colors.text, colors.foreground, '下書きの文字色が標準に戻るはず');
		} finally {
			await invokeApp(client, 'set_draft_text_color', { light: '', dark: '' });
		}
	});

	test('選んだ文字色は、起動し直しても残る', async () => {
		await invokeApp(client, 'set_draft_text_color', { light: '#123456', dark: '#abcdef' });
		await waitFor(tryReadConfig, (cfg) => cfg?.textColorLight === '#123456', {
			label: 'config.toml の textColorLight (起動し直す前)'
		});
		// 出したままだと、次の起動でホットキーを送ったときに閉じる側に働くので隠しておく
		await showDraftAndWaitVisible();
		await hideDraftWithoutCopy(client);
		await waitDraftHidden('下書きウィンドウの非表示 (Esc 後)');
		await suite.closeClient(client);

		client = await suite.newClient();
		await showDraftAndWaitVisible('下書きウィンドウの表示 (起動し直した後)');
		const expected = await resolveColor('#123456');
		const colors = await waitFor(readDraftColors, (current) => current.text === expected, {
			label: '下書きの文字色 (起動し直した後)'
		});
		assert.equal(colors.text, expected, '起動し直しても選んだ色のはず');
	});
});
