import test from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_MIN_SIZE, DRAFT_TITLE } from '../lib/app-conf.mjs';
import {
	hideDraft,
	holdUserState,
	relaunchWithConfig,
	relaunchWithTestConfig,
	restoreUserState,
	setWindowFrame,
	showDraft,
	windowButtonsEnabled,
	windowFrame
} from '../lib/macos.mjs';
import { waitFor } from '../lib/wait.mjs';

// 下書きウィンドウの位置と大きさを macOS で見る。macOS では位置の記録を隠すときに書き出し、
// 最小化・拡大のボタンはウィンドウの作りで止めているので、Windows の E2E とは別に見る

test.describe('macOS: 下書きウィンドウの位置と大きさ', () => {
	test.before(async () => {
		await holdUserState();
		await relaunchWithTestConfig();
	});

	test.after(async () => {
		await restoreUserState();
	});

	test('最小化と拡大のボタンは押せない', async () => {
		await showDraft();
		assert.deepEqual(await windowButtonsEnabled(DRAFT_TITLE), { minimize: false, zoom: false });
		await hideDraft();
	});

	test('縮めても、最小の大きさより小さくならない', async () => {
		await showDraft();
		const opened = await windowFrame(DRAFT_TITLE);
		await setWindowFrame(DRAFT_TITLE, { ...opened, width: 200, height: 150 });
		const shrunk = await windowFrame(DRAFT_TITLE);
		// タイトルバーを中身に重ねているので、枠の大きさが中身の最小の大きさと同じになる (実機で読んだ値)
		assert.deepEqual({ width: shrunk.width, height: shrunk.height }, DRAFT_MIN_SIZE);
		await hideDraft();
	});

	test('動かして大きさを変えると、隠して出し直しても、起動し直しても、その位置と大きさで出る', async () => {
		await showDraft();
		const opened = await windowFrame(DRAFT_TITLE);
		const moved = { x: opened.x + 40, y: opened.y - 30, width: 620, height: 420 };
		await setWindowFrame(DRAFT_TITLE, moved);
		const before = await waitFor(
			() => windowFrame(DRAFT_TITLE),
			(f) =>
				f.x === moved.x && f.y === moved.y && f.width === moved.width && f.height === moved.height,
			{ label: '位置と大きさが変わる' }
		);
		await hideDraft();

		await showDraft();
		assert.deepEqual(await windowFrame(DRAFT_TITLE), before, '隠して出し直すと、同じ位置と大きさ');
		await hideDraft();

		await relaunchWithConfig();
		await showDraft();
		assert.deepEqual(await windowFrame(DRAFT_TITLE), before, '起動し直しても、同じ位置と大きさ');
		await hideDraft();
	});
});
