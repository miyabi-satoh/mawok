import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	KEY,
	activeWindow,
	bindHotkey,
	closeApp,
	draftFocused,
	ensureSessionEnv,
	isDraftVisible,
	launchApp,
	mawokWindows,
	pressHotkey,
	pressKeys,
	startDriver,
	typeText,
	unbindHotkey,
	waitDraftVisible
} from '../lib/linux.mjs';
import { expectStays, sleep, waitFor } from '../lib/wait.mjs';

// 「開く」「保存」のファイルの窓 (GTK のファイル選択) は、テキストウィンドウに結び付けて出し、出ている間はフォーカスが
// 外れてもテキストウィンドウを隠さない (lib.rs の draft_file_dialog と BlurCheck.file_dialog_open)。
// 手前に出るか・隠れないか・閉じた後に入力欄へフォーカスが戻るかは、デスクトップの窓の扱いで決まるので Linux で見る。
// ファイルの窓が出ている間は、WebDriver で画面を読まない (窓を閉じるまで応えないことがある)

test.describe('Linux: ファイルを開く・保存', () => {
	let driver;
	let app;
	let dir;

	test.before(async () => {
		await ensureSessionEnv();
		driver = await startDriver();
		await bindHotkey('toggle');
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mawok-file-dialog-'));
		app = await launchApp(driver);
	});

	test.after(async () => {
		await closeApp(app?.client);
		await driver?.stop();
		await unbindHotkey().catch(() => {});
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	});

	const textValue = () => app.client.execute(() => document.querySelector('textarea').value);

	/** テキストウィンドウを出し、入力欄を `text` にする */
	async function showDraftWith(text) {
		if (!(await isDraftVisible())) {
			await pressHotkey();
			await waitDraftVisible(true);
		}
		await waitFor(() => draftFocused(app.client), Boolean, { label: '入力欄にフォーカス' });
		await app.client.execute((t) => {
			const area = document.querySelector('textarea');
			area.value = t;
			area.dispatchEvent(new Event('input', { bubbles: true }));
		}, text);
		await waitFor(textValue, (v) => v === text, { label: '入力欄の中身' });
	}

	/** ファイルの窓 (Mawok の、テキストウィンドウでない窓) が手前に出て、テキストウィンドウも出たままなのを確かめる */
	async function expectDialogInFront() {
		const dialog = await waitFor(
			async () => (await mawokWindows()).find((w) => w.title !== 'Mawok'),
			Boolean,
			{ timeout: 10_000, label: 'ファイルの窓が出る' }
		);
		await waitFor(activeWindow, (w) => w?.app === dialog.app && w?.title === dialog.title, {
			label: 'ファイルの窓にフォーカスがある'
		});
		await expectStays(isDraftVisible, true, {
			label: 'ファイルの窓が出ている間、テキストウィンドウが隠れない',
			duration: 1500
		});
		return dialog;
	}

	async function expectDialogClosed() {
		await waitFor(
			async () => (await mawokWindows()).filter((w) => w.title !== 'Mawok').length,
			(n) => n === 0,
			{ timeout: 5_000, label: 'ファイルの窓が閉じる' }
		);
		assert.ok(await isDraftVisible(), 'テキストウィンドウが出たまま');
		await waitFor(() => draftFocused(app.client), Boolean, {
			label: '閉じた後、入力欄にフォーカスが戻る'
		});
	}

	/** 閉じた後も続けて打てる (ydotool のキーがテキストウィンドウに届く) */
	async function expectCanType(before) {
		await typeText('Z');
		await waitFor(textValue, (v) => v === `${before}Z`, { label: '続けて打った文字が入る' });
	}

	/** ファイルの窓の、場所を打つ欄にパスを打って決める */
	async function enterPath(file, { save }) {
		// 開く窓は Ctrl+L で場所の欄を出す。保存の窓は名前の欄にフォーカスがあり、絶対パスも受け付ける
		await pressKeys(KEY.ctrl, save ? KEY.a : KEY.l);
		await typeText(file);
		// 打ち終えてすぐの Enter は、GTK が場所の欄の補完を作り直している間に落ちて決まらない
		await sleep(500);
		await pressKeys(KEY.enter);
	}

	test('Ctrl+O で開く窓が手前に出て、選んだファイルの中身が入り、入力欄で続けて打てる', async () => {
		const file = path.join(dir, 'open-me.txt');
		await fs.writeFile(file, 'from-file');
		await showDraftWith('before-open');
		await pressKeys(KEY.ctrl, KEY.o);
		await expectDialogInFront();
		await enterPath(file, { save: false });
		await expectDialogClosed();
		assert.equal(await textValue(), 'from-file');
		await app.client.execute(() => {
			const area = document.querySelector('textarea');
			area.setSelectionRange(area.value.length, area.value.length);
		});
		await expectCanType('from-file');
	});

	test('「開く...」のボタンで開く窓が出て、取り消すとテキストウィンドウが残り、続けて打てる', async () => {
		await showDraftWith('keep-open');
		await app.client.$('button[aria-label="開く..."]').click();
		await expectDialogInFront();
		await pressKeys(KEY.esc);
		await expectDialogClosed();
		assert.equal(await textValue(), 'keep-open');
		await expectCanType('keep-open');
	});

	test('Ctrl+S で保存の窓が手前に出て、保存すると知らせが出て、続けて打てる', async () => {
		const file = path.join(dir, 'saved.txt');
		await showDraftWith('to-save');
		await pressKeys(KEY.ctrl, KEY.s);
		await expectDialogInFront();
		await enterPath(file, { save: true });
		await expectDialogClosed();
		await waitFor(
			() => fs.readFile(file, 'utf8').catch(() => null),
			(v) => v === 'to-save',
			{
				label: '保存したファイルの中身'
			}
		);
		await waitFor(
			() => app.client.execute(() => document.body.innerText),
			(t) => t.includes('「saved.txt」に保存しました。'),
			{ label: '保存の知らせ' }
		);
		await expectCanType('to-save');
	});

	test('「保存...」のボタンで保存の窓が出て、取り消すとテキストウィンドウが残り、続けて打てる', async () => {
		await showDraftWith('keep-save');
		await app.client.$('button[aria-label="保存..."]').click();
		await expectDialogInFront();
		await pressKeys(KEY.esc);
		await expectDialogClosed();
		assert.equal(await textValue(), 'keep-save');
		await expectCanType('keep-save');
	});
});
