import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_TITLE } from '../lib/app-conf.mjs';
import {
	holdUserState,
	loginItemsAtLogin,
	openSettings,
	pressWindowElement,
	raiseWindow,
	relaunchWithConfig,
	restoreUserState,
	windowElements
} from '../lib/macos.mjs';
import { waitFor } from '../lib/wait.mjs';

// ログイン時の起動を macOS で見る。登録は OS ごとに別の作り (macOS はログイン項目、Windows はレジストリの Run) なので、
// Windows の E2E とは別に見る。ログインし直して本当に起動するかは見られないので、手での確認に残す。
// 利用者のログイン項目の登録を書き換えるので、終わったら `restoreUserState` が利用者の状態に戻す

const APP_NAME = 'Mawok.app';
const SWITCH = 'ログイン時に起動';

/** 設定の「ログイン時に起動」のスイッチの値 (1 か 0)。設定の画面を読み込み終えるまでは null */
async function autostartSwitch() {
	const elements = (await windowElements(SETTINGS_TITLE)) ?? [];
	return elements.find(({ role, name }) => role === 'AXCheckBox' && name === SWITCH)?.value ?? null;
}

/** 設定の「ログイン時に起動」を押して、スイッチが `expected` になるまで待つ */
async function toggleAutostart(expected) {
	await raiseWindow(SETTINGS_TITLE);
	await pressWindowElement(SETTINGS_TITLE, 'AXCheckBox', SWITCH);
	await waitFor(autostartSwitch, (value) => value === expected, {
		label: `「${SWITCH}」が ${expected} になる`
	});
}

test.describe('macOS: ログイン時の起動', () => {
	test.before(async () => {
		await holdUserState();
		await relaunchWithConfig('language = "ja"\nautostart = false\n');
	});

	test.after(async () => {
		await restoreUserState();
	});

	test('設定の「ログイン時に起動」をオンにするとシステム設定の「ログイン時に開く」に出て、オフにすると消える', async () => {
		assert.ok(
			!(await loginItemsAtLogin()).includes(APP_NAME),
			'オフの設定で起動した後は、ログイン項目に無い'
		);

		await openSettings();
		await waitFor(autostartSwitch, (value) => value === 0, { label: `「${SWITCH}」がオフで出る` });

		await toggleAutostart(1);
		assert.ok((await loginItemsAtLogin()).includes(APP_NAME), 'オンにすると、ログイン項目に出る');

		await toggleAutostart(0);
		assert.ok(
			!(await loginItemsAtLogin()).includes(APP_NAME),
			'オフに戻すと、ログイン項目から消える'
		);
	});
});
