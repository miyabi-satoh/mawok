import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE_IDENTIFIER } from '../lib/app-conf.mjs';
import {
	closeFinderWindow,
	finderSelection,
	finderWindowNames,
	frontmostApp,
	holdUserState,
	launchMawok,
	openSettings,
	pressInSettings,
	quitMawok,
	readTrayMenu,
	relaunchWithTestConfig,
	restoreUserState,
	writeConfigBytes
} from '../lib/macos.mjs';
import { waitFor } from '../lib/wait.mjs';

// 設定のファイルを読めないときにメニューバーのメニューに出る警告と、ログを Finder で表示することを
// macOS で見る。既定値で動くこと・読めないファイルを書き換えないことは、両 OS に共通の作りなので Windows の E2E
// (tests/settings-store.test.mjs) に任せ、ここではメニューバーのメニューと Finder の側だけを見る

/** メニューバーのメニューの「⚠ …」の項目の文言 */
async function readWarnings() {
	return (await readTrayMenu())
		.filter((name) => name?.startsWith('⚠ '))
		.map((name) => name.slice('⚠ '.length));
}

test.describe('macOS: 設定の置き場', () => {
	test.before(async () => {
		await holdUserState();
	});

	test.after(async () => {
		await restoreUserState();
	});

	test('TOML として読めない設定のファイルでは、メニューに読めないファイルの警告が出る', async () => {
		await quitMawok();
		await writeConfigBytes(Buffer.from('theme = \n'));
		await launchMawok();
		// 読めないと language も読めないので、文言の言語は OS の言語に従う。ここは日本語の macOS が前提
		assert.deepEqual(await readWarnings(), [
			'設定のファイル settings.toml を読めません。直すまで、変えた設定はこのファイルに保存されません'
		]);
	});

	test('設定の「ログを Finder で表示」で、ログのフォルダーが Finder で開き、ログが選ばれている', async () => {
		await relaunchWithTestConfig({ language: 'ja' });
		// 前から開いていたログのフォルダーのウィンドウは、利用者のものなので閉じない
		const openedBefore = (await finderWindowNames()).includes(PROFILE_IDENTIFIER);
		await openSettings('このアプリについて', 'ログを Finder で表示');
		await pressInSettings('AXButton', 'ログを Finder で表示');
		try {
			await waitFor(frontmostApp, (front) => front === 'Finder', { label: 'Finder が前面に出る' });
			assert.deepEqual(
				await waitFor(
					() => finderSelection(PROFILE_IDENTIFIER),
					(selected) => selected !== null,
					{ label: 'ログのフォルダーの Finder のウィンドウ' }
				),
				['Mawok.log']
			);
		} finally {
			if (!openedBefore) await closeFinderWindow(PROFILE_IDENTIFIER);
		}
	});
});
