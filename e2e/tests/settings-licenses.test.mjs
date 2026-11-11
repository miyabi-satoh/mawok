import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import { invokeApp, setJapanese, waitForWindowCount, waitSettingsWindow } from '../lib/app.mjs';
import { findVisibleMawokWindow, getForegroundWindowHandle } from '../lib/os.mjs';
import { LICENSES_TITLE } from '../lib/app-conf.mjs';
import { clickTitleBar, sendKeySequence, VK } from '../lib/input.mjs';
import { moveWindow, readWindow } from '../lib/window.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import { waitFor } from '../lib/wait.mjs';

// 第三者のソフトウェアのウィンドウの開け閉めと中身 (macOS は e2e/macos/licenses.test.mjs)。
// 設定の「ライセンスを表示」は WebDriver で押し、前面と閉じるキーは本物の入力で見る。
// ソースの置き場所のリンクは押さない (押すたびに既定のブラウザーにページが残る)

const suite = createSuite();
const SECTIONS = ['アプリ本体', '画面'];
const UNAVAILABLE = '一覧を読み込めませんでした。';

/** 節ごとの、行のパッケージ名と、一覧を読み込めなかった旨が出ているか */
function readSections(client) {
	return client.execute(() =>
		[...document.querySelectorAll('main section')].map((section) => ({
			title: section.querySelector('h2')?.textContent.trim() ?? '',
			packages: [...section.querySelectorAll('summary')].map((summary) =>
				// 名前の span には、下線の後ろで折るための <wbr> が入るので、textContent で読む
				summary.querySelector('span')?.textContent.trim()
			),
			text: section.textContent
		}))
	);
}

test.describe('第三者のソフトウェア', () => {
	let testConfig;
	let client;
	let draftHandle;
	let settingsHandle;
	let settingsHwnd;

	test.before(async () => {
		await suite.before();
		testConfig = await beginTestConfig({ language: 'ja' });
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
		await setJapanese(client);
		[draftHandle] = await client.getWindowHandles();
		await invokeApp(client, 'open_settings_window');
		({ settingsHandle, settingsHwnd } = await waitSettingsWindow(client, draftHandle));
		await client.switchToWindow(settingsHandle);
		await client.$('[role="tab"][data-value="about"]').click();
	});
	test.afterEach(async () => {
		await suite.closeClient(client);
	});

	/** 設定の「ライセンスを表示」を押し、ウィンドウが出て前面になるのを待つ。WebDriver は設定の窓に戻しておく */
	async function pressShowLicenses() {
		await client.switchToWindow(settingsHandle);
		await client.$('button=ライセンスを表示').click();
		const licensesHwnd = await waitFor(
			() => findVisibleMawokWindow(LICENSES_TITLE),
			(hwnd) => hwnd !== null,
			{ label: '第三者のソフトウェアのウィンドウ' }
		);
		await waitFor(getForegroundWindowHandle, (handle) => handle === licensesHwnd, {
			label: '第三者のソフトウェアのウィンドウが前面になる'
		});
		return licensesHwnd;
	}

	/**
	 * 設定のタイトルバーを押して前面にする。第三者のソフトウェアのウィンドウは設定の上に重なって出るので、
	 * 押す所が隠れないよう、先に下へずらす
	 */
	async function focusSettings(licensesHwnd) {
		const settings = await readWindow(settingsHwnd);
		const licenses = await readWindow(licensesHwnd);
		await moveWindow(licensesHwnd, {
			...licenses.window,
			y: settings.window.y + Math.round(100 * settings.scale)
		});
		await clickTitleBar(settingsHwnd);
		await waitFor(getForegroundWindowHandle, (handle) => handle === settingsHwnd, {
			label: '設定を前面にする'
		});
	}

	/** 第三者のソフトウェアのウィンドウへ WebDriver を移す */
	async function switchToLicenses() {
		const handles = await waitForWindowCount(client, 3);
		await client.switchToWindow(handles.find((h) => h !== draftHandle && h !== settingsHandle));
	}

	test('「ライセンスを表示」で、アプリ本体と画面の両方に1パッケージ1行で並び、もう一度押すと2つ目は出ずに前面に出る', async () => {
		const licensesHwnd = await pressShowLicenses();
		await switchToLicenses();
		const sections = await waitFor(
			() => readSections(client),
			(found) => found.length === SECTIONS.length && found.every((s) => s.packages.length > 0),
			{ label: '両方の節に行が並ぶ' }
		);
		assert.deepEqual(
			sections.map((s) => s.title),
			SECTIONS
		);
		for (const { title, packages, text } of sections) {
			assert.ok(!text.includes(UNAVAILABLE), `${title}: 一覧を読み込めなかった旨は出ないはず`);
			assert.equal(new Set(packages).size, packages.length, `${title}: 1パッケージ1行のはず`);
		}

		// 設定を前面に戻してから、もう一度押す
		await focusSettings(licensesHwnd);
		assert.equal(await pressShowLicenses(), licensesHwnd, '前と同じウィンドウが前面に出るはず');
		assert.equal((await client.getWindowHandles()).length, 3, '2つ目は出ないはず');
	});

	test('brotli の行を開くと、ソースの置き場所と BSD-3-Clause・MIT の条文が出る', async () => {
		await pressShowLicenses();
		await switchToLicenses();
		const summary = await waitFor(
			() =>
				client.execute(() => {
					const rows = [...document.querySelectorAll('main section')][0]?.querySelectorAll(
						'summary'
					);
					return [...(rows ?? [])].findIndex(
						(row) => row.querySelector('span')?.textContent.trim() === 'brotli'
					);
				}),
			(index) => index >= 0,
			{ label: 'アプリ本体に brotli の行がある' }
		);
		const row = (await client.$$('main section:first-of-type summary'))[summary];
		await row.click();
		const contents = await waitFor(
			() =>
				client.execute((index) => {
					const details = [...document.querySelectorAll('main section')][0].querySelectorAll(
						'details'
					)[index];
					return {
						open: details.open,
						links: [...details.querySelectorAll('a')].map((a) => a.getAttribute('href')),
						headings: [...details.querySelectorAll('h3')].map((h) => h.textContent.trim()),
						texts: [...details.querySelectorAll('h3 + p')].map((p) => p.textContent.trim())
					};
				}, summary),
			(found) => found.open && found.headings.length > 0,
			{ label: 'brotli の行の中身' }
		);
		assert.deepEqual(contents.links, ['https://github.com/dropbox/rust-brotli']);
		assert.deepEqual(
			[...contents.headings].sort(),
			['BSD 3-Clause "New" or "Revised" License', 'MIT License'],
			'2つのライセンスの条文の見出し'
		);
		assert.equal(
			contents.texts.length,
			contents.headings.length,
			'見出しごとに条文の本文が出るはず'
		);
		for (const text of contents.texts) {
			assert.ok(text.length > 500, `条文の本文が出るはず: ${text.slice(0, 80)}`);
		}
	});

	for (const [name, combo] of [
		['Esc', [VK.ESCAPE]],
		['Ctrl+W', [VK.CONTROL, VK.W]]
	]) {
		test(`${name} で第三者のソフトウェアのウィンドウだけが閉じる`, async () => {
			await pressShowLicenses();
			await sendKeySequence([combo]);
			await waitForWindowCount(client, 2, { label: `${name} で閉じる` });
			assert.equal(
				await findVisibleMawokWindow(LICENSES_TITLE),
				null,
				`${name} で第三者のソフトウェアのウィンドウが閉じるはず`
			);
			assert.ok(
				(await client.getWindowHandles()).includes(settingsHandle),
				`${name} で設定は閉じないはず`
			);
		});
	}

	test('開いたまま設定を閉じると、第三者のソフトウェアのウィンドウも閉じる', async () => {
		await focusSettings(await pressShowLicenses());
		await sendKeySequence([[VK.ESCAPE]]);
		await waitForWindowCount(client, 1, { label: '設定と一緒に閉じる' });
		assert.equal(await findVisibleMawokWindow(LICENSES_TITLE), null);
	});
});
