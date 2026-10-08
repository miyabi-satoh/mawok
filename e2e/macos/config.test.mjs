import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_IDENTIFIER } from '../lib/app-conf.mjs';
import {
	brokenConfigCopies,
	closeFinderWindow,
	closeSettings,
	finderSelection,
	finderWindowNames,
	frontmostApp,
	holdUserState,
	openSettings,
	pressInSettings,
	readTrayMenu,
	relaunchWithTestConfig,
	restoreUserState
} from '../lib/macos.mjs';
import { waitFor } from '../lib/wait.mjs';

// 設定ファイルを読めないときにメニューバーのメニューに出る警告と、設定ファイルを Finder で表示することを
// macOS で見る。既定値で動くこと・写しの中身・コメントが残ることは、両 OS に共通の作りなので Windows の E2E
// (tests/config-file.test.mjs) に任せ、ここではメニューバーのメニューと Finder の側だけを見る

/** メニューバーのメニューの、選べない「⚠ …」の項目の文言 */
async function readWarnings() {
	return (await readTrayMenu())
		.filter((name) => name?.startsWith('⚠ '))
		.map((name) => name.slice('⚠ '.length));
}

test.describe('macOS: 設定ファイル', () => {
	// テストが作らせた config.broken-….toml は、restoreUserState が消す
	test.before(async () => {
		await holdUserState();
	});

	test.after(async () => {
		await restoreUserState();
	});

	test('TOML として読めない設定ファイルでは、メニューに読めない旨の警告が出る', async () => {
		await relaunchWithTestConfig('language = \n');
		// 読めないと language も読めないので、文言の言語は OS の言語に従う。ここは日本語の macOS が前提
		const warnings = await readWarnings();
		assert.equal(warnings.length, 1, 'メニューに警告が1つ出る');
		assert.match(warnings[0], /^設定ファイルを読めません: /);
	});

	test('1項目だけ型を崩すとメニューにその項目の名前が出て、設定を変えると写した先のファイル名の知らせに変わる', async () => {
		await relaunchWithTestConfig('language = "ja"\ntheme = 1\n');
		assert.deepEqual(await readWarnings(), [
			'設定ファイルの読めない値と重なったキーを直しました: theme'
		]);

		const copiesBefore = await brokenConfigCopies();
		await openSettings();
		await pressInSettings('AXRadioButton', 'ライト');
		const copies = await waitFor(
			brokenConfigCopies,
			(names) => names.length === copiesBefore.length + 1,
			{ label: 'config.broken-….toml ができる' }
		);
		const created = copies.find((name) => !copiesBefore.includes(name));
		await closeSettings();
		assert.deepEqual(await readWarnings(), [`元の設定ファイルを ${created} に写しました`]);
	});

	test('設定の「Finder で表示」で、設定フォルダーが Finder で開き、config.toml が選ばれている', async () => {
		await relaunchWithTestConfig('language = "ja"\n');
		// 前から開いていた設定フォルダーのウィンドウは、利用者のものなので閉じない
		const openedBefore = (await finderWindowNames()).includes(APP_IDENTIFIER);
		await openSettings('このアプリについて', 'Finder で表示');
		await pressInSettings('AXButton', 'Finder で表示');
		try {
			await waitFor(frontmostApp, (front) => front === 'Finder', { label: 'Finder が前面に出る' });
			assert.deepEqual(
				await waitFor(
					() => finderSelection(APP_IDENTIFIER),
					(selected) => selected !== null,
					{ label: '設定フォルダーの Finder のウィンドウ' }
				),
				['config.toml']
			);
		} finally {
			if (!openedBefore) await closeFinderWindow(APP_IDENTIFIER);
		}
	});
});
