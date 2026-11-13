import test from 'node:test';
import assert from 'node:assert/strict';
import {
	KEY,
	bindHotkey,
	clipboardText,
	clipboardTypes,
	closeApp,
	draftFocused,
	ensureSessionEnv,
	launchApp,
	pressHotkey,
	pressKeys,
	startDriver,
	typeText,
	unbindHotkey,
	waitDraftVisible
} from '../lib/linux.mjs';
import { waitFor } from '../lib/wait.mjs';

// Linux のクリップボードは、書いたプロセスが求めに応じて中身を配るので、Mawok はコピーした後も持ち続ける
// (lib.rs の with_clipboard)。窓を隠した後に、ほかのアプリと同じく wl-paste で読めることを見る。
// 履歴に残さない印は、KDE の慣習の形式 (x-kde-passwordManagerHint) を一緒に書く (docs/platform.md「クリップボードの履歴に残さない」)

const HINT = 'x-kde-passwordManagerHint';

test.describe('Linux: クリップボード', () => {
	let driver;
	let app;

	test.before(async () => {
		await ensureSessionEnv();
		driver = await startDriver();
		await bindHotkey('toggle');
	});

	test.after(async () => {
		await closeApp(app?.client);
		await driver?.stop();
		await unbindHotkey().catch(() => {});
	});

	/** ホットキーで出して文字を打ち、Ctrl+Enter でコピーして隠す */
	async function copyTyped(text) {
		await pressHotkey();
		await waitDraftVisible(true);
		await waitFor(() => draftFocused(app.client), Boolean, { label: '入力欄にフォーカス' });
		await typeText(text);
		await waitFor(
			() => app.client.execute(() => document.querySelector('textarea').value),
			(value) => value === text,
			{ label: '打った文字が入力欄に入る' }
		);
		await pressKeys(KEY.ctrl, KEY.enter);
		await waitDraftVisible(false, 'Ctrl+Enter でコピーして隠れる');
	}

	test('Ctrl+Enter でコピーすると、窓を隠した後も wl-paste で読め、履歴に残さない印が付く', async () => {
		app = await launchApp(driver);
		await copyTyped('linux-clip-1');
		assert.equal(await clipboardText(), 'linux-clip-1');
		assert.ok((await clipboardTypes()).includes(HINT), `${HINT} の形式がある`);
	});

	test('「クリップボードの履歴に残さない」をオフにすると、印を付けずにコピーする', async () => {
		await closeApp(app.client);
		app = await launchApp(driver, { excludeFromClipboardHistory: false });
		await copyTyped('linux-clip-2');
		assert.equal(await clipboardText(), 'linux-clip-2');
		assert.ok(!(await clipboardTypes()).includes(HINT), `${HINT} の形式が無い`);
	});
});
