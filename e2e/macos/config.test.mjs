import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE_IDENTIFIER } from '../lib/app-conf.mjs';
import {
	brokenConfigCopies,
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

// 設定の置き場を読めないときにメニューバーのメニューに出る警告と、ログを Finder で表示することを
// macOS で見る。既定値で動くこと・写しの中身は、両 OS に共通の作りなので Windows の E2E
// (tests/settings-store.test.mjs) に任せ、ここではメニューバーのメニューと Finder の側だけを見る

/** メニューバーのメニューの、選べない「⚠ …」の項目の文言 */
async function readWarnings() {
	return (await readTrayMenu())
		.filter((name) => name?.startsWith('⚠ '))
		.map((name) => name.slice('⚠ '.length));
}

test.describe('macOS: 設定の置き場', () => {
	// テストが作らせた settings.broken-….db は、restoreUserState が消す
	test.before(async () => {
		await holdUserState();
	});

	test.after(async () => {
		await restoreUserState();
	});

	test('SQLite として読めない置き場では、メニューに写した先のファイル名の警告が出る', async () => {
		const copiesBefore = await brokenConfigCopies();
		await quitMawok();
		await writeConfigBytes(Buffer.from('not a database'));
		await launchMawok();
		const copies = await brokenConfigCopies();
		const created = copies.find((name) => !copiesBefore.includes(name));
		assert.ok(created, 'settings.broken-….db ができる');
		// 読めないと language も読めないので、文言の言語は OS の言語に従う。ここは日本語の macOS が前提
		assert.deepEqual(await readWarnings(), [
			`設定を読めなかったため、元のファイルを ${created} に写して、既定の設定で始めました`
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
