import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
	APP_PATH,
	AUTOSTART_FILE,
	closeApp,
	ensureSessionEnv,
	invoke,
	launchApp,
	startDriver
} from '../lib/linux.mjs';
import { waitFor } from '../lib/wait.mjs';

// ログイン時の起動。Linux は XDG autostart の .desktop を直接書く・消す (autostart.rs の Linux の imp)。
// ログインし直して本当に起動するかはデスクトップの側なので見ない。.desktop は利用者のものと同じ場所なので、
// linux-run.mjs が全体の前後で控えて戻し、回している間は外しておく。設定画面と同じコマンド (set_autostart) で切り替える

const readEntry = () => fs.readFile(AUTOSTART_FILE, 'utf8').catch(() => null);

test.describe('Linux: ログイン時の起動', () => {
	let driver;
	let app;

	test.before(async () => {
		await ensureSessionEnv();
		driver = await startDriver();
		await fs.rm(AUTOSTART_FILE, { force: true });
		app = await launchApp(driver, { autostart: false });
	});

	test.after(async () => {
		await closeApp(app?.client);
		await driver?.stop();
		await fs.rm(AUTOSTART_FILE, { force: true });
	});

	test('オンにすると今の実行ファイルを指す .desktop を書き、オフにすると消す', async () => {
		assert.equal(await readEntry(), null, 'オフの設定で起動したときは .desktop が無い');

		await invoke(app.client, 'set_autostart', { enabled: true });
		const entry = await waitFor(readEntry, (text) => text !== null, {
			label: 'オンにしたときの .desktop'
		});
		assert.match(entry, /^\[Desktop Entry\]$/m);
		assert.match(entry, new RegExp(`^Exec=${APP_PATH}$`, 'm'), 'Exec が起動した実行ファイル');
		assert.match(entry, /^X-GNOME-Autostart-enabled=true$/m);

		await invoke(app.client, 'set_autostart', { enabled: false });
		await waitFor(readEntry, (text) => text === null, {
			label: 'オフにしたときに .desktop が消える'
		});
	});

	test('デスクトップの設定で切られた (Hidden=true) .desktop は、起動したときに設定をオフにそろえる', async () => {
		await closeApp(app.client);
		await fs.writeFile(
			AUTOSTART_FILE,
			`[Desktop Entry]\nType=Application\nName=Mawok\nExec=${APP_PATH}\nHidden=true\n`
		);
		app = await launchApp(driver, { autostart: true });
		const view = await waitFor(
			() => invoke(app.client, 'get_settings'),
			(settings) => settings?.autostart === false,
			{ label: '切られた .desktop を見て、設定がオフになる' }
		);
		assert.equal(view.autostart, false);
	});
});
