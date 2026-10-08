import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	showDraftAndWaitVisible,
	typeIntoDraft,
	hideDraft,
	hideDraftWithoutCopy,
	waitDraftHidden
} from '../lib/app.mjs';
import {
	getClipboard,
	setClipboard,
	isDraftWindowVisible,
	getDraftWindowHandle,
	getForegroundWindowHandle
} from '../lib/os.mjs';
import { waitFor } from '../lib/wait.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import { launchPasteTarget, expectPasted } from '../lib/paste-target.mjs';
import { clickWindow } from '../lib/input.mjs';

// 貼り付け先を前面にする → ホットキー → 入力 → Ctrl+Enter → クリップボード → 貼り付け先へ
// フォーカスが戻り、Ctrl+V で届く、の一番基本的な流れ。
// 末尾の空白文字を取り除く設定は既定でオンなので、末尾に改行・空白を付けたときに
// 取り除かれ、貼り付け先にも末尾の改行が入らないことも合わせて見る。
//
// ホットキーで下書きが実際に (ネイティブウィンドウとして) 表示・非表示になったことも、
// Win32 API (IsWindowVisible) で見る。WebDriver はウィンドウが非表示でも DOM を操作できて
// しまうため、ここを見ないと「グローバルホットキーが壊れていても通ってしまうテスト」になる。
// 同じ理由で、貼り付けは WebDriver ではなく本物のキー入力 (SendInput) で送り、貼り付け先の
// 中身は UI Automation で読む

const suite = createSuite();
const SENTINEL = 'e2e-sentinel-before';

test.describe('下書き → クリップボード → 貼り付け先', () => {
	let testConfig;

	test.before(async () => {
		await suite.before();
		// ユーザーが末尾除去の設定を変えていても、このテストは既定の挙動を
		// 前提にしているので、テストの間だけ固定する
		testConfig = await beginTestConfig({
			trimTrailingWhitespace: true,
			replacements: [],
			punctuationStyle: 'keep',
			// 下書きを出したままほかのウィンドウをクリックするテストがあるので、隠さないようにする。
			// そのとき下書きがほかのウィンドウの下に回り、クリックで戻れなくならないよう、最前面にする
			hideTextWindowOnBlur: false,
			textWindowAlwaysOnTop: true
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

	let client;
	let pasteTarget;
	test.beforeEach(async () => {
		client = await suite.newClient();
		assert.equal(await isDraftWindowVisible(), false, '起動直後は下書きが非表示のはず');
		// 下書きを出す前に前面だったアプリが戻り先になるので、貼り付け先を前面にしておく
		pasteTarget = await launchPasteTarget();
		await pasteTarget.activate();
	});
	test.afterEach(async () => {
		try {
			await pasteTarget?.close();
		} finally {
			await suite.closeClient(client);
		}
	});

	test('入力した文字がそのままクリップボードに入り、戻り先の貼り付け先に貼り付けられる', async () => {
		await setClipboard(SENTINEL);
		const text = `e2e roundtrip ${Date.now()}`;

		await showDraftAndWaitVisible();

		await typeIntoDraft(client, text);
		await hideDraft(client);

		await waitDraftHidden('下書きウィンドウの非表示 (Ctrl+Enter 後)');
		const clipboard = await waitFor(getClipboard, (value) => value === text, {
			label: 'クリップボード'
		});
		assert.equal(clipboard, text);
		assert.equal(await expectPasted(pasteTarget, text), text);
	});

	// 下書きを隠すだけでも、OS は直前にアクティブだったウィンドウを前面にする。上下のテストでは
	// それがたまたま貼り付け先なので、戻り先へフォーカスを戻す処理 (focus.rs の SetForegroundWindow) を
	// 外しても通ってしまう (実際に外して確かめた)。下書きを出したままほかのウィンドウをアクティブにして
	// から下書きへ戻り、直前にアクティブだったウィンドウと戻り先を食い違わせて、戻す処理そのものを見る
	for (const { key, hide, copies } of [
		{ key: 'Ctrl+Enter', hide: hideDraft, copies: true },
		{ key: 'Esc', hide: hideDraftWithoutCopy, copies: false }
	]) {
		test(`下書きを出したままほかのウィンドウに移って戻っても、${key} で出したときの戻り先へフォーカスが戻る`, async () => {
			const bystander = await launchPasteTarget({
				title: 'Mawok E2E 間に挟むウィンドウ',
				left: 560,
				top: 40
			});
			try {
				// 起動したウィンドウに前面を取られていると戻り先がずれるので、貼り付け先を前面にし直す
				await pasteTarget.activate();
				await setClipboard(SENTINEL);
				const text = `e2e return target ${Date.now()}`;

				await showDraftAndWaitVisible();
				await typeIntoDraft(client, text);

				await bystander.activate();
				assert.equal(
					await isDraftWindowVisible(),
					true,
					'hideTextWindowOnBlur をオフにしているので出たままのはず'
				);
				const draftHwnd = await getDraftWindowHandle();
				await clickWindow(draftHwnd);
				await waitFor(getForegroundWindowHandle, (handle) => handle === draftHwnd, {
					label: 'クリックで下書きへ戻る'
				});

				await hide(client);
				await waitDraftHidden(`下書きウィンドウの非表示 (${key} 後)`);
				const expected = copies ? text : SENTINEL;
				await waitFor(getClipboard, (value) => value === expected, { label: 'クリップボード' });
				assert.equal(await expectPasted(pasteTarget, expected), expected);
			} finally {
				await bystander.close();
			}
		});
	}

	test('末尾の改行・空白が取り除かれ、貼り付け先にも末尾の改行が入らない', async () => {
		await setClipboard(SENTINEL);
		const base = `e2e trailing ${Date.now()}`;
		// 末尾に改行・半角スペース・全角スペースを付ける。タブ文字は WebDriver 経由の入力では
		// 実際の Tab キー押下として扱われテキストエリアからフォーカスが外れてしまうため使わない
		// (タブそのものの除去は Rust 側の単体テスト removes_trailing_fullwidth_space_and_tab で担保済み)
		// eslint-disable-next-line no-irregular-whitespace -- 全角スペースを末尾に付けるテストなので意図的
		const withTrailing = `${base}\n\n 　`;

		await showDraftAndWaitVisible();

		await typeIntoDraft(client, withTrailing);
		await hideDraft(client);

		await waitDraftHidden('下書きウィンドウの非表示 (Ctrl+Enter 後)');
		const clipboard = await waitFor(getClipboard, (value) => value === base, {
			label: 'クリップボード (末尾除去後)'
		});
		assert.equal(clipboard, base);
		assert.equal(await expectPasted(pasteTarget, base), base);
	});

	test('Esc はコピーせずに隠してフォーカスを戻し、クリップボードは変わらず書きかけが残る', async () => {
		await setClipboard(SENTINEL);
		const text = `e2e no-copy ${Date.now()}`;

		await showDraftAndWaitVisible();

		await typeIntoDraft(client, text);
		await hideDraftWithoutCopy(client);

		await waitDraftHidden('下書きウィンドウの非表示 (Esc 後)');
		// クリップボードが変わっていないことを、書き込み側の待ちが起きないことも含めて確認する
		assert.equal(await getClipboard(), SENTINEL);
		// 貼り付けても、下書きに書いた文字ではなく元のクリップボードの中身が入る
		assert.equal(await expectPasted(pasteTarget, SENTINEL), SENTINEL);

		await showDraftAndWaitVisible('下書きウィンドウの再表示');
		const textarea = await client.$('textarea');
		assert.equal(await textarea.getValue(), text, '書きかけが入力欄に残っているはず');
	});
});
