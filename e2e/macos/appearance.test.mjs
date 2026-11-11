import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_TITLE } from '../lib/app-conf.mjs';
import {
	closeSettings,
	holdUserState,
	openSettings,
	pressCloseButton,
	pressInSettings,
	pressWindowElement,
	relaunchWithTestConfig,
	restoreUserState,
	windowElements,
	windowNames
} from '../lib/macos.mjs';
import { waitFor } from '../lib/wait.mjs';

// 文字色の色見本が macOS の色選び (NSColorPanel) を開くことを見る。選んだ色が欄に入って下書きに当たる流れは、
// 両 OS に共通の画面のコードなので Windows の E2E (tests/draft-text-color.test.mjs) に任せる

/** 日本語の macOS で、色選びのパネルの題 */
const COLOR_PANEL_TITLE = 'カラー';
const PICK_LIGHT = 'ライトの文字色を選ぶ';

test.describe('macOS: テキストの見た目', () => {
	test.before(async () => {
		await holdUserState();
		await relaunchWithTestConfig({ language: 'ja' });
	});

	test.after(async () => {
		await restoreUserState();
	});

	test('文字色の色見本を押すと、macOS の色選びが開く', async () => {
		await openSettings();
		await pressInSettings('AXRadioButton', 'テキストの見た目');
		// 色見本は <input type="color"> で、役割は WebKit が決める。名前 (aria-label) で探して、その役割で押す
		const swatch = await waitFor(
			async () => ((await windowElements(SETTINGS_TITLE)) ?? []).find((e) => e.name.startsWith(PICK_LIGHT)),
			Boolean,
			{ timeout: 10_000, label: '文字色の色見本が出る' }
		);
		await pressWindowElement(SETTINGS_TITLE, swatch.role, PICK_LIGHT);
		try {
			assert.ok(
				await waitFor(windowNames, (names) => names.includes(COLOR_PANEL_TITLE), {
					label: '色選びのパネルが出る'
				})
			);
		} finally {
			if ((await windowNames()).includes(COLOR_PANEL_TITLE)) await pressCloseButton(COLOR_PANEL_TITLE);
			await closeSettings();
		}
	});
});
