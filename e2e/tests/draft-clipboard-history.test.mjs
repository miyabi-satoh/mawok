import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	showDraftAndWaitVisible,
	typeIntoDraft,
	hideDraft,
	invokeApp,
	waitDraftHidden
} from '../lib/app.mjs';
import {
	getClipboard,
	getClipboardFormats,
	isClipboardHistoryEnabled,
	isInClipboardHistory,
	removeFromClipboardHistory
} from '../lib/os.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';
import { beginTestConfig } from '../lib/config.mjs';

// クリップボードの履歴に残さない印。コピーしたとき、本文とは別に
// `ExcludeClipboardContentFromMonitorProcessing` という形式がクリップボードに載ることを見る
// (`lib.rs` の write_clipboard が arboard の exclude_from_monitoring で付ける印)。
// Win+V の履歴に本当に出ないか (OS の側の振る舞い) は、WinRT の Clipboard.GetHistoryItemsAsync で履歴を読んで見る。
// 履歴がオフの機 (「設定 → システム → クリップボード」) では、その2つのテストを飛ばす。印の付け方は OS ごとに別の作り
// (macOS は nspasteboard.org の慣習) なので、このテストが見ているのは Windows の作りだけ。
//
// 設定のオン・オフは、設定画面ではなく設定画面と同じコマンド (set_exclude_from_clipboard_history) で行う

const MARKER = 'ExcludeClipboardContentFromMonitorProcessing';

const suite = createSuite();

test.describe('クリップボードの履歴に残さない印', () => {
	let testConfig;
	let client;

	test.before(async () => {
		await suite.before();
		// 印の有無だけを見たいので、コピーの整えは既定のまま固定する
		testConfig = await beginTestConfig({
			excludeFromClipboardHistory: true,
			trimTrailingWhitespace: true,
			replacements: [],
			punctuationStyle: 'keep'
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

	/** 下書きに書いてコピーし、クリップボードに載った形式の名前を返す */
	async function copyAndReadFormats(text) {
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, text);
		await hideDraft(client);
		await waitDraftHidden('下書きウィンドウの非表示 (Ctrl+Enter 後)');
		// 印は本文と同じ書き込みで載るので、本文が届いてから読めば、印も載り終わっている
		await waitFor(getClipboard, (value) => value === text, { label: 'クリップボード' });
		return getClipboardFormats();
	}

	test('設定がオンなら、コピーに履歴に残さない印が付く', async () => {
		const formats = await copyAndReadFormats(`e2e conceal ${Date.now()}`);
		assert.ok(
			formats.includes(MARKER),
			`履歴に残さない印が付いているはず (載っている形式: ${formats.join(', ')})`
		);
	});

	test('設定がオンなら、Win+V の履歴に出ない', async (t) => {
		if (!(await isClipboardHistoryEnabled())) {
			t.skip('クリップボードの履歴がオフの機なので飛ばす');
			return;
		}
		const text = `e2e conceal history ${Date.now()}`;
		try {
			await copyAndReadFormats(text);
			// 履歴に入るのは、クリップボードに載った少し後。載った後もしばらく入らないことを見る
			await expectStays(() => isInClipboardHistory(text), false, {
				label: 'Win+V の履歴に出ないはず',
				duration: 2000
			});
		} finally {
			await removeFromClipboardHistory(text);
		}
	});

	test('設定をオフにすると、Win+V の履歴に出る', async (t) => {
		if (!(await isClipboardHistoryEnabled())) {
			t.skip('クリップボードの履歴がオフの機なので飛ばす');
			return;
		}
		await invokeApp(client, 'set_exclude_from_clipboard_history', { enabled: false });
		const text = `e2e no-conceal history ${Date.now()}`;
		try {
			await copyAndReadFormats(text);
			await waitFor(
				() => isInClipboardHistory(text),
				(found) => found,
				{
					label: 'Win+V の履歴に出る'
				}
			);
		} finally {
			await removeFromClipboardHistory(text);
			await invokeApp(client, 'set_exclude_from_clipboard_history', { enabled: true });
		}
	});

	test('設定をオフにすると、コピーに印が付かない', async () => {
		await invokeApp(client, 'set_exclude_from_clipboard_history', { enabled: false });
		const text = `e2e no-conceal ${Date.now()}`;
		let formats;
		try {
			formats = await copyAndReadFormats(text);
		} finally {
			// 履歴がオンの機では、印の無いコピーが Win+V の履歴に残るので消す
			if (await isClipboardHistoryEnabled()) await removeFromClipboardHistory(text);
		}
		assert.equal(
			formats.includes(MARKER),
			false,
			`印は付かないはず (載っている形式: ${formats.join(', ')})`
		);
		// 印がないだけで、本文はふつうにクリップボードに載っている (CF_UNICODETEXT = 13)
		assert.ok(
			formats.includes('13'),
			`本文は載っているはず (載っている形式: ${formats.join(', ')})`
		);
	});
});
