import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_TITLE } from '../lib/app-conf.mjs';
import {
	KEY,
	click,
	configText,
	draftState,
	draftTexts,
	drag,
	elementFrames,
	escapeComposition,
	frameCenter,
	hideDraft,
	holdUserState,
	isDraftVisible,
	keyCode,
	keystroke,
	launchPasteTarget,
	openSettings,
	paletteOptions,
	pasteTargetPoint,
	relaunchWithTestConfig,
	restoreUserState,
	showDraft,
	showDraftWith,
	typeReading,
	waitDraftHidden,
	waitDraftValue,
	waitSettingsWindow
} from '../lib/macos.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';

// 定型文のうち、Windows の E2E (WebDriver) で見られないものを macOS で見る。
// - 設定の行のつまみのドラッグ (本物のマウスで動かす)
// - 下書きの Cmd+J の一覧の、WKWebView でのキーと日本語入力、ほかのアプリに移ったとき
// 定型文は config.toml で登録する。名前は英数にし、日本語入力は変換中のキーを見るときだけ使う
// (ライブ変換の結果しだいで、絞り込みに当たらなくなるため)。項目の名前で押すので、日本語で起動する

const BODY = 'one\ntwo';
const SNIPPETS = [
	{ name: 'kakunin', body: BODY },
	{ name: '', body: 'git status' },
	{ name: 'third', body: 'c' }
];

const snippetsToml = (snippets) =>
	snippets
		.map(
			({ name, body }) =>
				`\n[[snippets]]\nname = ${JSON.stringify(name)}\nbody = ${JSON.stringify(body)}\n`
		)
		.join('');

// TOML の文字列 (複数行の """…""" と '''…'''、1行の "…" と '…')
const TOML_STRING = /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'[^']*'/;

function tomlString(text) {
	if (/^("""|''')/.test(text)) return text.slice(3, -3).replace(/^\n/, '');
	return text.startsWith('"') ? JSON.parse(text) : text.slice(1, -1);
}

/**
 * 設定ファイルに書かれた定型文 (名前を省いた行は名前を空にそろえる)。macOS の確認は e2e の依存を入れずに動かすので、
 * TOML の読み手を使わず、ここで書く形 (名前と本文の文字列だけ) を読む
 */
async function savedSnippets() {
	const blocks = ((await configText()) ?? '').split(/^\[\[snippets\]\]$/m).slice(1);
	return blocks.map((block) => {
		// 次の表の見出しから後は、この定型文のものではない
		const own = block.split(/^\[/m)[0];
		const field = (key) => {
			const match = own.match(new RegExp(`^${key} = (${TOML_STRING.source})`, 'm'));
			return match === null ? '' : tomlString(match[1]);
		};
		return { name: field('name'), body: field('body') };
	});
}

/**
 * 英数で下書きを出して `abc` と書き、`b` と `c` の間にカーソルを置く。出ているとホットキーで隠れるので、
 * 前の確認が出したままなら Esc で隠してから出す。一覧や変換が残っていると、Esc はまずそれを閉じるので、隠れるまで送る
 */
async function prepareDraft() {
	await keyCode(KEY.eisu);
	const layers = async () => ({ visible: await isDraftVisible(), palette: await isPaletteOpen() });
	for (let i = 0; i < 4; i++) {
		const before = await layers();
		if (!before.visible) break;
		await keyCode(KEY.escape);
		// 一覧か下書きが閉じるまで待ってから次を送る。変換を取り消しただけの Esc では、どちらも閉じない
		await waitFor(
			layers,
			(now) => now.visible !== before.visible || now.palette !== before.palette,
			{ timeout: 1000, label: 'Esc で一覧か下書きが閉じる' }
		).catch(() => {});
	}
	await waitDraftHidden('前の確認が出したままの下書きを隠す');
	await showDraftWith('abc');
	await keyCode(KEY.left);
	await waitFor(draftState, (s) => s.caret?.[0] === 2 && s.caret?.[1] === 2, {
		label: '`b` と `c` の間のカーソル'
	});
}

/** Cmd+J で一覧を出し、絞り込みの欄にフォーカスがあるまで待って、行を返す */
async function openPalette() {
	await keyCode(KEY.j, ['command down']);
	await waitFor(
		draftState,
		(s) => s.focusedRole !== null && s.focusedRole !== 'AXTextArea' && s.value === '',
		{
			label: '絞り込みの欄にフォーカスがある'
		}
	);
	return waitFor(paletteOptions, (options) => options !== null && options.length > 0, {
		label: '定型文の一覧'
	});
}

const isPaletteOpen = async () => (await paletteOptions()) !== null;

const paletteStaysOpen = (label) => expectStays(isPaletteOpen, true, { label, duration: 700 });

test.describe('macOS: 定型文', () => {
	let target;

	test.before(async () => {
		target = await launchPasteTarget();
		await holdUserState();
		await relaunchWithTestConfig(`language = "ja"\n${snippetsToml(SNIPPETS)}`, {
			clearHistory: true
		});
	});

	test.after(async () => {
		await keyCode(KEY.eisu).catch(() => {});
		await target?.close();
		await restoreUserState();
	});

	test('Cmd+J で一覧が出て絞り込みの欄にフォーカスがあり、名前のない定型文は本文で出る', async () => {
		await prepareDraft();
		const options = await openPalette();
		assert.equal(options.length, 4, JSON.stringify(options));
		assert.ok(options[0].startsWith('kakunin'), JSON.stringify(options));
		assert.equal(options[1], 'git status');
		assert.ok(options[3].startsWith('テキストを定型文に登録'), JSON.stringify(options));
		await keyCode(KEY.escape);
		await waitFor(paletteOptions, (current) => current === null, { label: 'Esc で一覧が閉じる' });
		await expectStays(isDraftVisible, true, { label: '一覧を閉じた Esc の後、下書きは出たまま' });
		await waitFor(
			draftState,
			(s) =>
				s.focusedRole === 'AXTextArea' &&
				s.value === 'abc' &&
				s.caret?.[0] === 2 &&
				s.caret?.[1] === 2,
			{ label: '入力欄にフォーカスが戻り、カーソルは一覧を出したときの位置' }
		);
	});

	test('変換中の Enter と Esc は変換の操作になり、確定してからの Enter でカーソルの位置に差し込み、Cmd+Z で戻る', async () => {
		await prepareDraft();
		await openPalette();

		// 変換中の Esc は変換の取り消しで、一覧は閉じない
		await typeReading();
		await escapeComposition('', isPaletteOpen);

		// 変換中の Enter は変換の確定で、差し込まない
		await typeReading();
		await keyCode(KEY.return);
		await paletteStaysOpen('変換中の Enter で一覧は閉じないはず');

		// 確定した文を英数の名前に打ち直し、Enter で、一覧を出したときのカーソルの位置に差し込む
		await keyCode(KEY.eisu);
		await keystroke('a', ['command down']);
		await keystroke('kakunin');
		// 絞り込む前の一覧も先頭は kakunin なので、絞り込みの欄が打ち直した名前になったことも待つ
		await waitFor(
			async () => ({ options: await paletteOptions(), draft: await draftState() }),
			({ options, draft }) => draft.value === 'kakunin' && options?.[0]?.startsWith('kakunin'),
			{ label: '絞り込んだ一覧の先頭' }
		);
		await keyCode(KEY.return);
		const inserted = `ab${BODY}c`;
		const draft = await waitFor(draftState, (s) => s.value === inserted, {
			label: 'カーソルの位置に差し込まれる'
		});
		assert.equal(await paletteOptions(), null, '差し込んだら一覧は閉じるはず');
		assert.deepEqual(
			draft.caret,
			[2 + BODY.length, 2 + BODY.length],
			'カーソルは差し込んだ本文の直後'
		);

		await keystroke('z', ['command down']);
		await waitDraftValue('abc');
	});

	test('一覧を出したままほかのアプリをクリックして隠し、出し直すと一覧は閉じて入力欄から始まる', async () => {
		await prepareDraft();
		await openPalette();
		await click(await pasteTargetPoint());
		await waitDraftHidden('ほかのアプリをクリックして、下書きウィンドウが隠れる');

		await showDraft();
		await waitFor(
			async () => ({ options: await paletteOptions(), draft: await draftState() }),
			({ options, draft }) =>
				options === null && draft.focusedRole === 'AXTextArea' && draft.value === 'abc',
			{ label: '一覧が閉じて入力欄にフォーカスがある' }
		);
	});

	test('末尾の「テキストを定型文に登録」を選ぶと、下書きはそのままで知らせが出て、設定に残り、次の一覧に出る', async () => {
		await prepareDraft();
		await openPalette();
		for (let i = 0; i < 3; i++) await keyCode(KEY.down);
		await keyCode(KEY.return);
		const draft = await waitFor(
			async () => ({ options: await paletteOptions(), draft: await draftState() }),
			({ options, draft }) => options === null && draft.focusedRole === 'AXTextArea',
			{ label: '一覧が閉じて入力欄にフォーカスがある' }
		);
		assert.equal(draft.draft.value, 'abc', '下書きは変わらないはず');
		assert.deepEqual(draft.draft.caret, [2, 2], 'カーソルは一覧を出したときの位置のまま');
		await waitFor(draftTexts, (texts) => texts.includes('定型文に登録しました。'), {
			label: '登録した知らせ'
		});
		const saved = await waitFor(
			savedSnippets,
			(current) => current.length === SNIPPETS.length + 1,
			{
				label: '設定ファイルに足された定型文'
			}
		);
		assert.deepEqual(saved, [...SNIPPETS, { name: '', body: 'abc' }]);

		const options = await openPalette();
		assert.equal(options[3], 'abc', JSON.stringify(options));
		await keyCode(KEY.escape);
		await hideDraft();
	});

	test('設定の「定型文」で、行のつまみをドラッグして並べ替えると保存され、下書きの一覧もその順で出る', async () => {
		await relaunchWithTestConfig(`language = "ja"\n${snippetsToml(SNIPPETS)}`);
		await openSettings('定型文', '追加');
		const grips = await waitFor(
			() => elementFrames(SETTINGS_TITLE, 'AXButton', 'ドラッグして並べ替え'),
			(frames) => frames.length === SNIPPETS.length,
			{ label: '行のつまみ' }
		);
		const last = grips.at(-1);
		// 先頭の行を、末尾の行の下の端まで運ぶ
		await drag(frameCenter(grips[0]), { x: frameCenter(last).x, y: last.y + last.height });
		const moved = [SNIPPETS[1], SNIPPETS[2], SNIPPETS[0]];
		await waitFor(savedSnippets, (current) => JSON.stringify(current) === JSON.stringify(moved), {
			label: 'ドラッグした並びの保存'
		});

		await keyCode(KEY.escape);
		await waitSettingsWindow(false);
		await prepareDraft();
		const options = await openPalette();
		assert.deepEqual(
			options.slice(0, 3).map((option) => option.split(' ')[0]),
			['git', 'third', 'kakunin']
		);
	});
});
