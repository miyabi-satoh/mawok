import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	closeDraftSettings,
	hideDraft,
	invokeApp,
	openSettingsFromDraft,
	selectCopyCategory,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitDraftHidden,
	waitForWindowCount
} from '../lib/app.mjs';
import { getClipboard, setClipboard, isDraftWindowVisible } from '../lib/os.mjs';
import { waitFor } from '../lib/wait.mjs';
import { tryReadConfig, beginTestConfig } from '../lib/config.mjs';
import { launchPasteTarget, expectPasted } from '../lib/paste-target.mjs';

// 設定と加工の組み合わせの通し: Ctrl+, で設定を開く (下書きは隠れる) → 置き換え辞書に1行足す
// (この時点で config.toml に書かれる) → 設定を閉じる (下書きが出し直される) → 下書きで
// 同じ語を書いてコピー → 置き換わっていて、戻り先の貼り付け先にも置き換えた後の文字が届く。
// 最後に、足した行を設定画面から (テストが直接 config.toml を書き換えるのではなく、
// ユーザーがするのと同じ操作で) 削除する。
//
// 設定ウィンドウを開いている間は下書きが隠れ、閉じると出し直される (`lib.rs` の
// `hide_draft_for_settings` / `show_again`) ので、下書きへの入力は設定を閉じた後で行う。
// 隠れる・出し直されること自体もこのテストで押さえる。
//
// 設定ファイルは常用のものを直接読み書きするため、テストの前後で退避・復元する
// (中断されたときの保険は createSuite / beginTestConfig 側で見ている)。

const suite = createSuite();
const SENTINEL = 'e2e-sentinel-before';

test.describe('設定 (置き換え辞書) → 下書きへの反映', () => {
	let testConfig;
	let client;

	test.before(async () => {
		await suite.before();
		// 無関係な辞書が既に登録されていても、このテストが影響を受けないよう、テストの間だけ固定する
		testConfig = await beginTestConfig({
			replacements: [],
			punctuationStyle: 'keep'
		});
	});
	test.after(async () => {
		// testConfig.restore() が失敗しても (あるいは before で beginTestConfig 自体が失敗して
		// testConfig が未設定でも)、tauri-driver の終了とロックの解放は必ず行う
		try {
			await testConfig?.restore();
		} finally {
			await suite.after();
		}
	});

	let pasteTarget;
	test.beforeEach(async () => {
		client = await suite.newClient();
		// 戻り先は下書きをホットキーで出したときに前面だったアプリで、設定を閉じて出し直しても
		// 変わらない (`show_again` は戻り先を記録し直さない)。なので出す前に貼り付け先を前面にしておく
		pasteTarget = await launchPasteTarget();
		await pasteTarget.activate();
		await showDraftAndWaitVisible();
		await setJapanese(client);
	});
	test.afterEach(async () => {
		try {
			await pasteTarget?.close();
		} finally {
			await suite.closeClient(client);
		}
	});

	test('置き換え辞書に登録した内容が config.toml に書かれ、下書きのコピーと貼り付け先に反映される', async () => {
		const from = `E2Eフロム${Date.now()}`;
		const to = `E2Eトゥ${Date.now()}`;

		// 設定を開くと下書きは隠れる (config.toml を書き換えるためではなく、
		// 並べて見る場面がないための仕様)
		const draftHandle = await openSettingsFromDraft(client);

		const addButton = await selectCopyCategory(client);
		await addButton.click();
		const fromInputs = await client.$$('input[aria-label="置き換える前の文字列"]');
		const toInputs = await client.$$('input[aria-label="置き換えた後の文字列"]');
		const lastFrom = fromInputs[fromInputs.length - 1];
		const lastTo = toInputs[toInputs.length - 1];
		await lastFrom.setValue(from);
		await lastTo.setValue(to);

		// 入力のたびに保存される実装 (bind:value の setter で saveReplacements() を呼ぶ) なので、
		// ウィンドウを閉じなくても config.toml に反映されるはず
		const config = await waitFor(
			tryReadConfig,
			(cfg) => cfg?.replacements?.some((r) => r.from === from && r.to === to && r.enabled),
			{ label: 'config.toml の replacements' }
		);
		assert.ok(config.replacements.some((r) => r.from === from && r.to === to));

		// 設定を Esc で閉じると、隠していた下書きが出し直される。下書きへの入力は
		// (設定ウィンドウが表示中は WebView2 が描画を止めていて操作できないので) この後で行う
		await closeDraftSettings(client, draftHandle);

		await setClipboard(SENTINEL);
		await typeIntoDraft(client, `${from}のテスト`);
		await hideDraft(client);

		await waitDraftHidden('下書きウィンドウの非表示 (Ctrl+Enter 後)');
		const clipboard = await waitFor(getClipboard, (value) => value === `${to}のテスト`, {
			label: 'クリップボード (置き換え後)'
		});
		assert.equal(clipboard, `${to}のテスト`);
		assert.equal(await expectPasted(pasteTarget, `${to}のテスト`), `${to}のテスト`);

		// 足した行を、直接 config.toml を書き換えるのではなく設定画面から削除する。
		// config.toml 自体はテスト終了時に丸ごと復元するが、途中で落ちた場合の残骸を
		// できるだけ小さくするための後始末。下書きは隠れているので Ctrl+, では開けず、
		// トレイと同じ入口 (open_settings_window) を invoke で呼ぶ
		await invokeApp(client, 'open_settings_window');
		// この時点で下書きは既に (Ctrl+Enter でコピーして隠したことで) 隠れているので、ここでの非表示は
		// 「開き直しで新たに隠れた」ことの確認ではなく、隠れたままであることの確認
		assert.equal(await isDraftWindowVisible(), false, '下書きは隠れたままのはず');
		const reopenedHandles = await waitForWindowCount(client, 2);
		const reopenedSettingsHandle = reopenedHandles.find((h) => h !== draftHandle);
		await client.switchToWindow(reopenedSettingsHandle);

		// 開き直すと「一般」の分類に戻っている
		await selectCopyCategory(client);
		const removeButtons = await client.$$('button[aria-label="この行を削除"]');
		await removeButtons[removeButtons.length - 1].click();
		await waitFor(
			tryReadConfig,
			// cfg が undefined (読み取り中の一時的な失敗) のときは「まだ削除できていない」扱いにする。
			// `!cfg?.replacements?.some(...)` だと undefined を「削除済み」と誤判定してしまう
			(cfg) => cfg !== undefined && !cfg.replacements?.some((r) => r.from === from && r.to === to),
			{ label: 'config.toml の replacements (削除後)' }
		);
	});
});
