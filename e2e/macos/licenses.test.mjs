import test from 'node:test';
import assert from 'node:assert/strict';
import { LICENSES_TITLE, SETTINGS_TITLE } from '../lib/app-conf.mjs';
import {
	KEY,
	closeSettings,
	focusedWindowName,
	holdUserState,
	keyCode,
	openSettings,
	pressInSettings,
	pressWindowElement,
	raiseWindow,
	relaunchWithTestConfig,
	restoreUserState,
	windowElements,
	windowNames
} from '../lib/macos.mjs';
import { waitFor } from '../lib/wait.mjs';

// 第三者のソフトウェアのウィンドウの開け閉めと中身を macOS で見る。窓・ボタン・節の名前で探すので、日本語で起動する。
// ソースの置き場所のリンクは押さない (押すたびに既定のブラウザーにページが残る)

const SECTIONS = ['アプリ本体', '画面'];
const UNAVAILABLE = '一覧を読み込めませんでした。';

/** 節の名前ごとの、行 (開閉の三角。名前は「パッケージ名 版 ライセンス」) の名前 */
function rowsBySection(elements) {
	const rows = new Map();
	let section = null;
	for (const { role, name } of elements) {
		if (role === 'AXHeading' && SECTIONS.includes(name)) {
			section = name;
			rows.set(section, []);
		} else if (role === 'AXDisclosureTriangle' && section !== null) {
			rows.get(section).push(name);
		}
	}
	return rows;
}

/** `prefix` で始まる行を開いて出た中身 (その行の後ろから、次の行の手前まで) */
function rowContents(elements, prefix) {
	const start = elements.findIndex(
		({ role, name }) => role === 'AXDisclosureTriangle' && name.startsWith(prefix)
	);
	if (start < 0) return [];
	const end = elements.findIndex((e, i) => i > start && e.role === 'AXDisclosureTriangle');
	return elements.slice(start + 1, end < 0 ? undefined : end);
}

const isLicensesOpen = async () => (await windowNames()).includes(LICENSES_TITLE);

/** 設定の「ライセンスを表示」を押し、両方の節に行が並ぶまで待って、窓の中の要素を返す */
async function openLicenses() {
	await pressInSettings('AXButton', 'ライセンスを表示');
	return waitFor(
		() => windowElements(LICENSES_TITLE),
		(elements) =>
			elements !== null &&
			SECTIONS.every((section) => (rowsBySection(elements).get(section)?.length ?? 0) > 0),
		{ timeout: 15_000, label: '第三者のソフトウェアのウィンドウに、両方の節の行が並ぶ' }
	);
}

test.describe('macOS: 第三者のソフトウェア', () => {
	test.before(async () => {
		await holdUserState();
		await relaunchWithTestConfig('language = "ja"\n');
		await openSettings('このアプリについて', 'ライセンスを表示');
	});

	test.after(async () => {
		await restoreUserState();
	});

	test('「ライセンスを表示」で、アプリ本体と画面の両方に1パッケージ1行で並び、もう一度押すと2つ目は出ずに前面に出る', async () => {
		const elements = await openLicenses();
		assert.ok(
			!elements.some(({ value }) => value === UNAVAILABLE),
			'一覧を読み込めなかった旨が出ない'
		);
		for (const [section, rows] of rowsBySection(elements)) {
			const names = rows.map((row) => row.split(' ')[0]);
			assert.equal(new Set(names).size, names.length, `${section}の行は1パッケージ1行`);
		}

		await raiseWindow(SETTINGS_TITLE);
		await waitFor(focusedWindowName, (name) => name === SETTINGS_TITLE, {
			label: '設定を前面に出す'
		});
		await pressInSettings('AXButton', 'ライセンスを表示');
		await waitFor(focusedWindowName, (name) => name === LICENSES_TITLE, {
			label: 'ライセンスのウィンドウが前面に出る'
		});
		assert.equal(
			(await windowNames()).filter((name) => name === LICENSES_TITLE).length,
			1,
			'2つ目は出ない'
		);
	});

	test('ring の行を開くと、ソースの置き場所と ISC・Apache-2.0・MIT の条文が出る', async () => {
		await openLicenses();
		await pressWindowElement(LICENSES_TITLE, 'AXDisclosureTriangle', 'ring ');
		const contents = await waitFor(
			async () => rowContents(await windowElements(LICENSES_TITLE), 'ring '),
			(elements) => elements.some(({ role }) => role === 'AXHeading'),
			{ label: 'ring の行の中身' }
		);
		const headings = contents.filter(({ role }) => role === 'AXHeading').map(({ name }) => name);
		assert.deepEqual(
			[...headings].sort(),
			['Apache License 2.0', 'ISC License', 'MIT License'],
			'3つのライセンスの条文の見出し'
		);
		assert.ok(
			contents.some(({ role, name }) => role === 'AXLink' && name.startsWith('https://')),
			'ソースの置き場所のリンクが出る'
		);
	});

	test('Esc でも Cmd+W でも閉じ、開いたまま設定を閉じると一緒に閉じる', async () => {
		for (const [key, modifiers, label] of [
			[KEY.escape, [], 'Esc'],
			[KEY.w, ['command down'], 'Cmd+W']
		]) {
			await openLicenses();
			await waitFor(focusedWindowName, (name) => name === LICENSES_TITLE, {
				label: `${label} の前に、ライセンスのウィンドウが前面`
			});
			await keyCode(key, modifiers);
			await waitFor(isLicensesOpen, (open) => !open, { label: `${label} で閉じる` });
			assert.ok((await windowNames()).includes(SETTINGS_TITLE), `${label} で設定は閉じない`);
		}

		await openLicenses();
		await closeSettings();
		await waitFor(isLicensesOpen, (open) => !open, { label: '設定と一緒に閉じる' });
	});
});
