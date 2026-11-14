import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DRAFT_TITLE } from '../lib/app-conf.mjs';
import {
	KEY,
	draftState,
	draftTexts,
	holdUserState,
	isDraftVisible,
	isFileDialogOpen,
	keyCode,
	keystroke,
	pressWindowElement,
	relaunchWithTestConfig,
	restoreUserState,
	showDraftWith,
	waitDraftFocused,
	waitDraftValue
} from '../lib/macos.mjs';
import { expectStays, sleep, waitFor } from '../lib/wait.mjs';

// 「開く」「保存」のファイルの窓は、テキストウィンドウに結び付けて (macOS ではシートで) 出し、出ている間はフォーカスが
// 外れてもテキストウィンドウを隠さない (lib.rs の draft_file_dialog と BlurCheck.file_dialog_open)。
// 隠れないか・閉じた後に入力欄へフォーカスが戻るかは、OS の窓の扱いで決まるので macOS で見る。
// 場所は「フォルダーへ移動」(Cmd+Shift+G) にパスを打って選ぶ。打つ文字は ASCII にする (System Events の keystroke のため)

test.describe('macOS: ファイルを開く・保存', () => {
	let dir;

	test.before(async () => {
		// サンドボックスの版でも、窓で選んだファイルは読み書きできる
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mawok-file-dialog-')));
		await holdUserState();
		await relaunchWithTestConfig();
	});

	test.after(async () => {
		await restoreUserState();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	});

	/** ファイルの窓が出て、出ている間テキストウィンドウが隠れないのを確かめる */
	async function expectDialogShown() {
		await waitFor(isFileDialogOpen, Boolean, { timeout: 10_000, label: 'ファイルの窓が出る' });
		await expectStays(isDraftVisible, true, {
			label: 'ファイルの窓が出ている間、テキストウィンドウが隠れない',
			duration: 1500
		});
	}

	/** ファイルの窓が閉じ、テキストウィンドウが出たまま入力欄にフォーカスが戻るのを確かめる */
	async function expectDialogClosed() {
		await waitFor(isFileDialogOpen, (open) => !open, {
			timeout: 10_000,
			label: 'ファイルの窓が閉じる'
		});
		await waitDraftFocused('閉じた後、テキストウィンドウが出たまま入力欄にフォーカスが戻る');
	}

	/** 「フォルダーへ移動」にパスを打つ */
	async function goTo(target) {
		await keystroke('g', ['command down', 'shift down']);
		// 移動の欄が出るのを待つ。出る前に打つと、ファイルの一覧の頭出しに使われる
		await sleep(1000);
		await keystroke(target);
		await sleep(500);
	}

	/**
	 * Return で決めて、窓が閉じるまで押し直す。移動の欄は、補完を選ぶのと欄を閉じるのに Return を1回ずつ使い、
	 * 何回で窓の既定のボタン (開く・保存) に届くかは補完の出方で変わるため
	 */
	async function confirm() {
		for (let i = 0; i < 5 && (await isFileDialogOpen()); i++) {
			await keyCode(KEY.return);
			await sleep(1000);
		}
	}

	/** 打った文字が入力欄に入る (カーソルは末尾に置いてから打つ) */
	async function expectCanType(before) {
		await keyCode(KEY.down, ['command down']);
		await keystroke('Z');
		await waitDraftValue(`${before}Z`);
	}

	test('Cmd+O で開く窓が出て、選んだファイルの中身が入り、入力欄で続けて打てる', async () => {
		const file = path.join(dir, 'open-me.txt');
		await fs.writeFile(file, 'from-file');
		await showDraftWith('before-open');
		await keyCode(KEY.o, ['command down']);
		await expectDialogShown();
		await goTo(file);
		await confirm();
		await expectDialogClosed();
		await waitDraftValue('from-file');
		await expectCanType('from-file');
	});

	test('「開く...」のボタンで開く窓が出て、取り消すとテキストウィンドウが残り、続けて打てる', async () => {
		await showDraftWith('keep-open');
		await pressWindowElement(DRAFT_TITLE, 'AXButton', '開く...');
		await expectDialogShown();
		await keyCode(KEY.escape);
		await expectDialogClosed();
		assert.equal((await draftState()).value, 'keep-open');
		await expectCanType('keep-open');
	});

	test('Cmd+S で保存の窓が出て、保存すると知らせが出て、続けて打てる', async () => {
		const file = path.join(dir, 'saved.txt');
		await showDraftWith('to-save');
		await keyCode(KEY.s, ['command down']);
		await expectDialogShown();
		// 名前の欄にフォーカスがある
		await keystroke('a', ['command down']);
		await keystroke('saved.txt');
		await goTo(dir);
		await confirm();
		await expectDialogClosed();
		await waitFor(
			() => fs.readFile(file, 'utf8').catch(() => null),
			(v) => v === 'to-save',
			{ label: '保存したファイルの中身' }
		);
		await waitFor(draftTexts, (texts) => texts.includes('「saved.txt」に保存しました。'), {
			label: '保存の知らせ'
		});
		await expectCanType('to-save');
	});

	test('「保存...」のボタンで保存の窓が出て、取り消すとテキストウィンドウが残り、続けて打てる', async () => {
		await showDraftWith('keep-save');
		await pressWindowElement(DRAFT_TITLE, 'AXButton', '保存...');
		await expectDialogShown();
		await keyCode(KEY.escape);
		await expectDialogClosed();
		assert.equal((await draftState()).value, 'keep-save');
		await expectCanType('keep-save');
	});
});
