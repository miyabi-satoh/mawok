import test from 'node:test';
import assert from 'node:assert/strict';
import { MANUAL_TITLE, TRAY_MENU_JA } from '../lib/app-conf.mjs';
import {
	ACTIVATION_POLICY,
	KEY,
	activationPolicy,
	focusedWindowName,
	holdUserState,
	closeSettings,
	keyCode,
	openSettings,
	pressInSettings,
	pressTrayMenuItem,
	relaunchWithTestConfig,
	restoreUserState,
	windowElements,
	windowNames
} from '../lib/macos.mjs';
import { waitFor } from '../lib/wait.mjs';

// 使い方のウィンドウを macOS で見る。メニューバーから開くと、常駐のアプリのまま窓を出すことになるので、
// 開いている間だけ Dock と Cmd+Tab に出し、設定とは別に閉じることを見る (activation policy の扱いは macOS だけの作り)

const isManualOpen = async () => (await windowNames()).includes(MANUAL_TITLE);

/** 使い方のウィンドウが出て、本文の節の見出しが並び、前面になるまで待つ */
async function waitManualShown(label) {
	await waitFor(
		async () =>
			((await windowElements(MANUAL_TITLE)) ?? []).filter(({ role }) => role === 'AXHeading')
				.length,
		(count) => count > 5,
		{ timeout: 15_000, label: `${label}: 使い方の本文の見出し` }
	);
	await waitFor(focusedWindowName, (name) => name === MANUAL_TITLE, {
		label: `${label}: 使い方のウィンドウが前面になる`
	});
}

const waitPolicy = (policy, label) =>
	waitFor(activationPolicy, (current) => current === policy, { label });

test.describe('macOS: 使い方', () => {
	test.before(async () => {
		await holdUserState();
		await relaunchWithTestConfig('language = "ja"\n');
	});

	test.after(async () => {
		await restoreUserState();
	});

	test('メニューの「使い方」で窓が出て、開いている間だけ Dock に出て、Esc で閉じる', async () => {
		await pressTrayMenuItem(TRAY_MENU_JA.manual);
		await waitManualShown('メニューから開く');
		await waitPolicy(ACTIVATION_POLICY.regular, '開いている間は Dock に出る');

		await keyCode(KEY.escape);
		await waitFor(isManualOpen, (open) => !open, { label: 'Esc で閉じる' });
		await waitPolicy(ACTIVATION_POLICY.accessory, '閉じると Dock から外れる');
	});

	test('設定の「使い方を表示」で開くと、設定を閉じても残り、Cmd+W で閉じると Dock から外れる', async () => {
		await openSettings('このアプリについて', '使い方を表示');
		await pressInSettings('AXButton', '使い方を表示');
		await waitManualShown('設定から開く');

		await closeSettings();
		assert.ok(await isManualOpen(), '設定を閉じても使い方は残る');
		assert.equal(
			await activationPolicy(),
			ACTIVATION_POLICY.regular,
			'使い方が開いている間は Dock に出たまま'
		);

		await waitFor(focusedWindowName, (name) => name === MANUAL_TITLE, {
			label: '設定を閉じた後、使い方のウィンドウが前面'
		});
		await keyCode(KEY.w, ['command down']);
		await waitFor(isManualOpen, (open) => !open, { label: 'Cmd+W で閉じる' });
		await waitPolicy(ACTIVATION_POLICY.accessory, '閉じると Dock から外れる');
	});
});
