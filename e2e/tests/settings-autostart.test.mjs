import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import { invokeApp, APP_PATH } from '../lib/app.mjs';
import { isAutostartApprovedEnabled, readAutostartEntry } from '../lib/os.mjs';
import { beginTestConfig, tryReadConfig } from '../lib/config.mjs';
import { waitFor } from '../lib/wait.mjs';

// ログイン時の起動。設定を切り替えると、レジストリの Run の値が消える・戻ることを見る。
// ログインし直して本当に起動するかは OS の側なので手に残す。macOS はログイン項目 (SMAppService) という別の作りなので、
// このテストが見ているのは Windows の作りだけ。
//
// アプリは起動したときにも登録を揃え、設定がオフなら登録を外す (`lib.rs` の settle_autostart) ので、
// オフの設定で起動して登録がない状態から始め、オン → オフの順で切り替えて両方向を見る。
// ここはユーザーの登録そのものを書き換える。控えて書き戻すのは、`just e2e` では run.mjs が全体の前後で1度、直接回すときは setup.mjs の createSuite がファイルごとに行う
// (`os.mjs` の snapshotAutostartEntry。中断されたときの保険も同じ仕組みが見ている)。
//
// 設定画面のスイッチではなく、設定画面と同じコマンド (set_autostart) で切り替える

const suite = createSuite();

test.describe('ログイン時の起動', () => {
	let testConfig;

	test.before(async () => {
		await suite.before();
		// 登録がない状態から始める
		testConfig = await beginTestConfig({ autostart: false });
	});
	test.after(async () => {
		// 設定ファイルの書き戻しが失敗しても、登録の書き戻しと tauri-driver の終了は必ず行う
		try {
			await testConfig?.restore();
		} finally {
			// ログイン時の起動の登録は、直接回すときは suite.after が書き戻す (`just e2e` では run.mjs が書き戻す)
			await suite.after();
		}
	});

	test('「ログイン時に起動」を切り替えると、レジストリの Run の値ができて消える', async () => {
		const client = await suite.newClient();
		try {
			await waitFor(readAutostartEntry, (entry) => entry.run === null, {
				label: 'オフの設定で起動したときの登録なし'
			});

			await invokeApp(client, 'set_autostart', { enabled: true });
			const registered = await waitFor(readAutostartEntry, (entry) => entry.run !== null, {
				label: 'オンにしたときの登録'
			});
			// 値は auto-launch が `<パス> <引数>` の形で書く (引用符は付かない)。末尾だけを見ると、
			// 常用版 (%LOCALAPPDATA%\Mawok\mawok.exe) の登録が残っていても通ってしまうので、パスで見る
			assert.ok(
				registered.run.toLowerCase().includes(APP_PATH.toLowerCase()),
				`登録の値は、E2E が起動した実行ファイル (${APP_PATH}) を指しているはず (実際: ${registered.run})`
			);
			// タスクマネージャーの「スタートアップ アプリ」でも有効になっていること。
			// 印そのものが無い環境では、下の判定 (読めなければ有効とみなす) が素通りするので、
			// オンにした直後に印が書かれたことを先に見る
			assert.notEqual(
				registered.approved,
				null,
				'オンにしたら、タスクマネージャーの印 (StartupApproved\\Run) が書かれるはず'
			);
			assert.equal(
				isAutostartApprovedEnabled(registered.approved),
				true,
				'オンにしたら、タスクマネージャーでも有効になるはず'
			);
			const config = await waitFor(tryReadConfig, (cfg) => cfg?.autostart === true, {
				label: 'config.toml の autostart (オン)'
			});
			assert.equal(config.autostart, true);

			await invokeApp(client, 'set_autostart', { enabled: false });
			const removed = await waitFor(readAutostartEntry, (entry) => entry.run === null, {
				label: 'オフに戻したときの登録なし'
			});
			// Run の値が消えれば、タスクマネージャーの一覧からも消える。オン・オフの印 (approved) は
			// auto-launch の disable が触らないので、有効のまま残る。ここが変わったら気づけるよう見ておく
			assert.equal(
				isAutostartApprovedEnabled(removed.approved),
				true,
				'オフにしても、オン・オフの印は有効のまま残るはず (一覧から消えるのは Run の値が消えるため)'
			);
			await waitFor(tryReadConfig, (cfg) => cfg?.autostart === false, {
				label: 'config.toml の autostart (オフ)'
			});
		} finally {
			await suite.closeClient(client);
		}
	});
});
