import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	showDraftAndWaitVisible,
	invokeApp,
	openDraftAppearanceSettings as openSettings,
	closeDraftSettings,
	readDraftColors,
	DEFAULT_HOTKEY
} from '../lib/app.mjs';
import { waitFor } from '../lib/wait.mjs';
import { beginTestConfig, tryReadConfig } from '../lib/config.mjs';

// 下書きの入力欄の案内。既定の案内の文言とキー、表示言語とホットキーへの追随、
// 設定画面での書き換え・空・既定に戻す、案内の色と斜体を見る。
// ライトとダークで見分けやすいかは人の目で判断するものなので手に残す。
//
// 案内は画面側 (`src/lib/guidance.ts`) が今の言語とホットキーから作る共通の作りなので、
// ここで見ているのは両 OS に共通の振る舞い。キーの並べ方だけが OS ごとに変わる (Windows は Ctrl+…)。
//
// 設定ファイルの input_guidance は、書いていなければ既定の案内、空文字なら案内を出さない、
// 文字列ならその文をそのまま出す (`src-tauri/src/config.rs`)。テストでは camelCase の inputGuidance で読み書きする (`lib/config.mjs`)

const suite = createSuite();

/** 既定の案内 (messages/ja.json の draft_guidance_write・summon・change をつないだもの) を、Windows のキーの並べ方で組み立てたもの */
const defaultGuidance = (hotkey = 'Ctrl+Shift+Space') =>
	`ここに書いて Ctrl+Enter を押すと、コピーして元のアプリに戻ります。あとは貼るだけです。${hotkey} でいつでも呼び出せます。\nこの案内は設定（Ctrl+,）で変えたり消したりできます。`;

const ENGLISH_GUIDANCE =
	'Write here and press Ctrl+Enter to copy it and go back to your app, ready to paste. Bring this back anytime with Ctrl+Shift+Space.\nChange or remove this hint in Settings (Ctrl+,).';

test.describe('下書きの入力欄の案内', () => {
	let testConfig;
	let client;

	test.before(async () => {
		await suite.before();
		// 案内は言語とホットキーから作られるので、言語も固定する (ホットキーは beginTestConfig が既定にする)。
		// inputGuidance は書かない状態 (既定の案内) から始める (null は項目を書かない意味)
		testConfig = await beginTestConfig({
			language: 'ja',
			theme: 'light',
			inputGuidance: null
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

	/** 入力欄に置かれている案内 (置かれていなければ null)。見えているかどうかとは別 */
	const readGuidance = () =>
		client.$('textarea').then((textarea) => textarea.getAttribute('placeholder'));

	/**
	 * 案内が実際に見えているか。placeholder 属性は入力欄の中身に左右されないので、
	 * 見えているかどうかは `:placeholder-shown` (入力欄が空のときだけ当たる) で見る
	 */
	const isGuidanceShown = () =>
		client.execute(() => {
			const textarea = document.querySelector('textarea');
			// 入力欄が無いのを「見えていない」と混ぜると、ウィンドウを取り違えても否定の assert が通る
			if (textarea === null) throw new Error('入力欄が見つかりません (下書き以外のウィンドウ?)');
			return textarea.matches(':placeholder-shown');
		});

	const openDraftAppearanceSettings = () => openSettings(client, '#draft-guidance');
	const closeSettings = (draftHandle) => closeDraftSettings(client, draftHandle);

	test('既定の案内が、今のホットキーと設定を開くキーで出る', async () => {
		await showDraftAndWaitVisible();
		assert.equal(await readGuidance(), defaultGuidance());
	});

	test('1文字打つと案内が消え、消して空にすると戻る', async () => {
		await showDraftAndWaitVisible();
		const textarea = await client.$('textarea');
		await textarea.click();

		assert.equal(await textarea.getValue(), '', '書き始める前の入力欄は空のはず');
		assert.equal(await isGuidanceShown(), true, '空なので案内が見えているはず');
		assert.equal(await readGuidance(), defaultGuidance(), '見えているのは既定の案内のはず');

		await client.keys(['a']);
		assert.equal(await textarea.getValue(), 'a', '打った文字が入るはず');
		assert.equal(await isGuidanceShown(), false, '1文字打つと案内は見えなくなるはず');

		await client.keys(['Control', 'a']);
		await client.keys(['Backspace']);
		assert.equal(await textarea.getValue(), '', '消すと入力欄は空に戻るはず');
		assert.equal(await isGuidanceShown(), true, '空に戻ると案内も見えるはず');
	});

	test('ホットキーを変えると、案内のキーも変わる', async () => {
		await showDraftAndWaitVisible();
		await invokeApp(client, 'set_hotkey', { accelerator: 'CommandOrControl+Alt+KeyJ' });
		try {
			const guidance = await waitFor(
				readGuidance,
				(text) => text === defaultGuidance('Ctrl+Alt+J'),
				{ label: '案内のキー (ホットキーを変えた後)' }
			);
			assert.equal(guidance, defaultGuidance('Ctrl+Alt+J'));
		} finally {
			// 設定ファイルに書かれ、このファイルのほかのテストに残るので戻す
			await invokeApp(client, 'set_hotkey', { accelerator: DEFAULT_HOTKEY });
		}
	});

	test('表示言語を切り替えると、案内もその言語になる', async () => {
		await showDraftAndWaitVisible();
		await invokeApp(client, 'set_language', { language: 'en' });
		try {
			const guidance = await waitFor(readGuidance, (text) => text === ENGLISH_GUIDANCE, {
				label: '案内の言語 (英語に切り替えた後)'
			});
			assert.equal(guidance, ENGLISH_GUIDANCE);
		} finally {
			await invokeApp(client, 'set_language', { language: 'ja' });
		}
	});

	test('設定画面で書き換えると、その文がそのまま出る。空にすると案内が出ない', async () => {
		const own = `E2E の案内 ${Date.now()}`;
		let draftHandle = await openDraftAppearanceSettings();
		await client.$('#draft-guidance').setValue(own);
		await waitFor(tryReadConfig, (cfg) => cfg?.inputGuidance === own, {
			label: 'config.toml の inputGuidance (書き換えた後)'
		});

		await closeSettings(draftHandle);
		// 設定の反映は settings-changed のイベントで非同期に届くので、変わるまで待つ
		assert.equal(
			await waitFor(readGuidance, (text) => text === own, {
				label: '下書きの案内 (書き換えた後)'
			}),
			own,
			'書いた文がそのまま出るはず'
		);

		draftHandle = await openDraftAppearanceSettings();
		// clearValue() は WebDriver が値を直に消すだけで、欄の bind:value の setter が動かず保存されない。
		// 人と同じようにキーで消す
		await client.$('#draft-guidance').click();
		await client.keys(['Control', 'a']);
		await client.keys(['Backspace']);
		await waitFor(tryReadConfig, (cfg) => cfg?.inputGuidance === '', {
			label: 'config.toml の inputGuidance (空にした後)'
		});

		await closeSettings(draftHandle);
		assert.equal(
			await waitFor(readGuidance, (text) => text === null, {
				label: '下書きの案内 (空にした後)'
			}),
			null,
			'空にしたら案内を出さないはず'
		);
	});

	test('「既定に戻す」で、欄とボタンが既定の状態に戻り、下書きにも既定の案内が出る', async () => {
		await invokeApp(client, 'set_draft_guidance', { guidance: 'E2E のひとこと' });
		const draftHandle = await openDraftAppearanceSettings();

		const reset = await client.$('//button[normalize-space()="既定に戻す"]');
		await reset.click();

		// 既定に戻すと、設定ファイルには書かれなくなる (Rust 側が既定のときは書き出さない)
		await waitFor(tryReadConfig, (cfg) => cfg !== undefined && cfg.inputGuidance === undefined, {
			label: 'config.toml の inputGuidance (既定に戻した後)'
		});
		assert.equal(
			await client.$('#draft-guidance').getValue(),
			defaultGuidance(),
			'欄が既定の案内に戻るはず'
		);
		assert.equal(await reset.isEnabled(), false, '戻すものがないので押せなくなるはず');

		await closeSettings(draftHandle);
		assert.equal(
			await waitFor(readGuidance, (text) => text === defaultGuidance(), {
				label: '下書きの案内 (既定に戻した後)'
			}),
			defaultGuidance(),
			'下書きにも既定の案内が出るはず'
		);
	});

	test('案内は、入力した文字と見分けられるよう、緑みの薄い色の斜体で出る', async () => {
		await showDraftAndWaitVisible();
		const colors = await readDraftColors(client);
		assert.equal(colors.guidance, colors.guidanceVariable, '案内の色は --draft-guidance のはず');
		assert.equal(colors.guidanceFontStyle, 'italic', '案内は斜体のはず');
		assert.notEqual(colors.guidance, colors.text, '入力した文字と同じ色では見分けられない');
	});
});
