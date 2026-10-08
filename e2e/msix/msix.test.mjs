// MSIX 版だけの作りの確認 (`just msix-check`)。
// `just msix` で作った MSIX を入れ、パッケージの中から CDP つきで起動して、画面と同じコマンドを送り、OS の側で結果を読む。
//
// 常用の MSIX 版と同じパッケージなので、動いている Mawok を終了し、常用版を外して、試す版を入れる。
// 終わった後は、元から MSIX 版が入っていれば、試した版が常用版として残る (外した版の MSIX は手元に残っていないため)。
// 入っていなければ外す。ログイン時の起動 (StartupTask) の状態と、動いていた Mawok (MSIX 版か EXE 版か) は、元に戻す。
// 設定・履歴は EXE 版と同じ場所の実物なので、E2E と同じく控えてからテスト用の設定に替える (lib/config.mjs)。
// EXE 版のファイルが無い環境は、その2つのフォルダーの名前を変えて退かして作る (lib/msix.mjs の holdAppData)。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
	APP_DATA_DIRS,
	acquireLock,
	beginTestConfig,
	recoverStaleBackupIfAny,
	registerCrashRecovery,
	releaseLock
} from '../lib/config.mjs';
import { logSize, readLogSince } from '../lib/files.mjs';
import { describeForegroundWindow, getMawokProcessId, stopPowerShell } from '../lib/os.mjs';
import { closeLeftoverTrayMenu, closeTrayMenu, openTrayMenu, readTrayMenu } from '../lib/tray.mjs';
import { waitFor } from '../lib/wait.mjs';
import {
	PAGE,
	STARTUP_TASK_STATE,
	addPackage,
	appUserModelId,
	backupLocalCache,
	builtMsixPath,
	clearLocalCacheBackup,
	clearOriginalRecord,
	clearStartupTaskState,
	clearToasts,
	closeSystemSettings,
	evaluate,
	holdAppData,
	invokeOrThrow,
	launchExecutable,
	launchInPackage,
	launchNormally,
	listRunningMawokPaths,
	listFirewallAlertWindows,
	measureTaskbarIconPlate,
	packageDataDir,
	readFirewallRules,
	readOriginalRecord,
	readPackage,
	readStartupTaskState,
	readToastTitles,
	recoverHeldAppDataIfAny,
	redirectedDataDirs,
	removePackage,
	restoreLocalCache,
	revealAndRead,
	stopMawok,
	stopMawokSync,
	writeOriginalRecord,
	writeStartupTaskState
} from '../lib/msix.mjs';

const CDP_PORT = 9340;
/** i18n.rs の autostart_turned_off_in_windows (日本語) */
const TURNED_OFF_IN_WINDOWS =
	'Windows の設定の「スタートアップ アプリ」でオフになっています。そこでオンにしてください。';
/**
 * 待ち受けを始めさせるための、組み合わせた機器。待ち受けは組み合わせた機器があるときだけ始まる。
 * アドレスは文書用の予約 (TEST-NET-1) で、どこにも届かない
 */
const PLACEHOLDER_DEVICE = {
	name: 'msix-check',
	publicKey: 'ab'.repeat(32),
	address: '192.0.2.1',
	sendTo: false
};

/**
 * 試す前の状態。後で戻す。`installed` は MSIX 版が入っていたか、`startupTask` はその StartupTask の状態、
 * `running` は動いていた Mawok (`'package'` は MSIX 版、文字列のパスは EXE 版、null は動いていなかった)。
 * 後始末が最後まで済むまでファイルにも控え、中断された次の回はそれを使う (lib/msix.mjs の readOriginalRecord)
 */
let original;
/** 動いている Mawok を止める直前に立てる。立っていなければ、後始末で何にも触らない (入れ替える前に落ちたとき) */
let touched = false;
let lockToken;
let pkg;

/** EXE 版と同じ場所のログのファイル */
const LOG_FILE = path.join(APP_DATA_DIRS.local, 'logs', 'Mawok.log');

before(async () => {
	lockToken = await acquireLock();
	// 中断されたら、先に Mawok を止めてから、退かしたフォルダーを戻す。パッケージの中から起動した Mawok は
	// コンソールの外で動いているので Ctrl+C では止まらず、動いたままだと、戻した設定・履歴をテストの値で上書きしうる。
	// どちらも同期で行うので、config.mjs の後始末 (設定を戻して終わる) より先に済む
	for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) {
		process.prependOnceListener(signal, () => {
			if (!touched) return;
			stopMawokSync();
			try {
				recoverHeldAppDataIfAny();
			} catch (error) {
				console.error('[msix] 中断時に、退かしたフォルダーを戻せませんでした:', error);
			}
		});
	}
	registerCrashRecovery(lockToken);
	const msix = builtMsixPath();
	if (!fs.existsSync(msix)) throw new Error(`MSIX がありません: ${msix} (先に just msix)`);

	const installed = await readPackage();
	const recorded = readOriginalRecord();
	if (recorded) {
		console.warn(
			`[msix] 前の回 (${recorded.savedAt}) の後始末が済んでいないので、そのときの元の状態に戻します`
		);
		original = recorded;
	} else {
		const runningPaths = await listRunningMawokPaths();
		const packaged = runningPaths.find(
			(exe) => installed && exe?.startsWith(installed.installLocation)
		);
		original = {
			installed: installed !== null,
			startupTask: installed ? await readStartupTaskState(installed) : null,
			running: packaged ? 'package' : (runningPaths.find(Boolean) ?? null)
		};
	}
	touched = true;
	// 前の回が強く止められていると、テストの Mawok が動いたままのことがある。戻す前に止めないと、戻した設定を上書きされる
	await stopMawok();
	await recoverStaleBackupIfAny();
	recoverHeldAppDataIfAny();
	if (!recorded) {
		// 外すと LocalCache が消えるので、元の版の分を先に写す。前の回の記録があるときは、そのときに写してある。
		// 写したかどうか ('copied'・'empty') を記録に残し、後始末はそれを見て戻す (控えのフォルダーがあるかでは決めない。
		// 前の回の控えが残っていて写せずに落ちたときに、その古い控えで上書きしないため)
		if (installed) original.localCache = await backupLocalCache(installed);
		writeOriginalRecord(original);
	}
	await removePackage();
	await addPackage(msix);
	pkg = await readPackage();
	assert.ok(pkg, 'MSIX を入れた後に、パッケージが見つかりません');
});

/** StartupTask を元の状態に戻す。有効にするのはアプリからしかできない (RequestEnableAsync) ので、そのときは起動して送る */
async function restoreStartupTask() {
	const current = await readStartupTaskState(pkg);
	if (current === original.startupTask) return;
	if (original.startupTask === STARTUP_TASK_STATE.enabled) {
		// 「スタートアップ アプリ」で切られた状態 (DisabledByUser) からは、アプリで有効にできない
		if (current === STARTUP_TASK_STATE.disabledByUser) {
			await writeStartupTaskState(pkg, STARTUP_TASK_STATE.disabled);
		}
		try {
			await launchInPackage(pkg, CDP_PORT);
			await invokeOrThrow(CDP_PORT, 'set_autostart', { enabled: true });
		} finally {
			// 起動した後の読み込み待ちで落ちても、CDP の口を開いた Mawok を残さない
			await stopMawok();
		}
	} else if (original.startupTask === null) {
		await clearStartupTaskState(pkg);
	} else {
		await writeStartupTaskState(pkg, original.startupTask);
	}
}

after(async () => {
	// ロックを取れなかった (ほかの実行が動いている) ときと、入れ替える前に落ちたときは、何にも触らない
	if (lockToken === undefined) return;
	try {
		if (!touched) return;
		// 1つが落ちても残りを試す。途中で止めると、常用版が止まったまま・フォルダーが退かされたまま、などで残る
		const errors = [];
		const attempt = async (label, step) => {
			try {
				await step();
			} catch (error) {
				errors.push(new Error(`${label}: ${error.message}`, { cause: error }));
			}
		};
		await attempt('Mawok を止める', stopMawok);
		await attempt('退かしたフォルダーを戻す', async () => recoverHeldAppDataIfAny());
		if (!original.installed) {
			await attempt('試した版を外す', removePackage);
		} else {
			// 入れ直せなかったときに、前の pkg (ファミリー名は同じ) のまま入っていない場所へ戻さないよう、読み直す
			pkg = undefined;
			await attempt('入れ直す', async () => {
				// 退かしている間に外したままで落ちたときは、入れ直す
				if ((await readPackage()) === null) await addPackage(builtMsixPath());
				pkg = await readPackage();
				if (!pkg) throw new Error('入れ直した後に、パッケージが見つかりません');
			});
			if (original.localCache) {
				await attempt('元の版の LocalCache を戻す', async () => {
					if (!pkg) throw new Error('パッケージが入っていないので戻せません (控えは残します)');
					await restoreLocalCache(pkg, original.localCache);
				});
			}
			// 設定は常用のものに戻っている (describe ごとの後始末)
			await attempt('StartupTask を戻す', async () => {
				if (!pkg) throw new Error('パッケージが入っていないので戻せません');
				await restoreStartupTask();
			});
		}
		await attempt('Mawok を起動し直す', async () => {
			if (original.running === 'package' && original.installed) await launchNormally(pkg);
			else if (original.running) await launchExecutable(original.running);
		});
		if (errors.length > 0) {
			throw new AggregateError(
				errors,
				`後始末の一部が失敗しました (${errors.map((error) => error.message).join(' / ')})。` +
					'次の回は、控えた元の状態に戻してから始めます'
			);
		}
		// 記録を先に消す。控えを消した後で記録を消せずに落ちると、次の回が「写した」の記録を見て、戻す元の無いまま LocalCache を消すため。
		// 控えが消し残っても、次の回は backupLocalCache が何かに触る前に止まる
		clearOriginalRecord();
		// 控えを消すのは、控えを取った回だけ。前の回の控えが残っていて写せずに落ちたときは、手で確かめられるよう残す
		if (original.localCache === 'copied') clearLocalCacheBackup();
	} finally {
		await releaseLock(lockToken);
		await stopPowerShell();
	}
});

describe('EXE 版のファイルがある環境', () => {
	let config;
	/** 起動する前のログの大きさ。前の起動のログを読まないため */
	let logOffset;

	before(async () => {
		config = await beginTestConfig({
			language: 'ja',
			autostart: false,
			pairedDevices: [PLACEHOLDER_DEVICE]
		});
		logOffset = logSize(LOG_FILE);
		await launchInPackage(pkg, CDP_PORT);
	});

	after(async () => {
		try {
			await closeLeftoverTrayMenu(await getMawokProcessId().catch(() => null));
			await stopMawok();
		} finally {
			await config?.restore();
		}
	});

	test('パッケージとして動き、EXE 版と同じ場所のログに書く', async () => {
		await waitFor(
			() => readLogSince(LOG_FILE, logOffset),
			(text) => text.includes('packaged (MSIX): true'),
			{ label: 'ログの packaged (MSIX): true' }
		);
	});

	test('ファイアウォール: マニフェストの受信の規則があり、待ち受けても許可のダイアログが出ない', async () => {
		const program = path.join(pkg.installLocation, 'mawok.exe');
		const rules = await readFirewallRules(program);
		const inbound = rules.filter((rule) => rule.direction === 'Inbound');
		for (const protocol of ['TCP', 'UDP']) {
			assert.ok(
				inbound.some(
					(rule) =>
						rule.protocol === protocol &&
						rule.action === 'Allow' &&
						rule.profile === 'Any' &&
						rule.enabled === 'True'
				),
				`${protocol} の受信をすべてのネットワークで許す規則がありません: ${JSON.stringify(rules)}`
			);
		}
		await waitFor(
			() => readLogSince(LOG_FILE, logOffset),
			(text) => text.includes('lan: listening on tcp'),
			{ label: '待ち受けの開始', timeout: 10000 }
		);
		// ダイアログは待ち受けを始めてすぐに出るので、少し見てから確かめる
		await new Promise((resolve) => setTimeout(resolve, 3000));
		assert.deepEqual(await listFirewallAlertWindows(), []);
	});

	test('ログイン時の起動: 設定のオン・オフで StartupTask が有効・無効になる', async () => {
		await invokeOrThrow(CDP_PORT, 'set_autostart', { enabled: true });
		assert.equal(await readStartupTaskState(pkg), STARTUP_TASK_STATE.enabled);
		await invokeOrThrow(CDP_PORT, 'set_autostart', { enabled: false });
		assert.equal(await readStartupTaskState(pkg), STARTUP_TASK_STATE.disabled);
	});

	test('ログイン時の起動: 「スタートアップ アプリ」で切られていると、Windows の設定が開き、設定画面とトレイの ⚠ に知らせが出る', async () => {
		await writeStartupTaskState(pkg, STARTUP_TASK_STATE.disabledByUser);
		await invokeOrThrow(CDP_PORT, 'open_settings_window');
		await waitFor(
			() =>
				evaluate(CDP_PORT, "!!document.getElementById('autostart')", { page: PAGE.settings }).catch(
					() => false
				),
			(ready) => ready === true,
			{ label: '設定画面の「ログイン時に起動」' }
		);
		// 設定画面のスイッチを押す (画面が set_autostart を送り、失敗を画面に出す)
		await evaluate(CDP_PORT, "document.getElementById('autostart').click()", {
			page: PAGE.settings
		});
		await waitFor(
			() => evaluate(CDP_PORT, 'document.body.innerText', { page: PAGE.settings }),
			(text) => text.includes(TURNED_OFF_IN_WINDOWS),
			{ label: '設定画面の知らせ' }
		);
		assert.equal(await readStartupTaskState(pkg), STARTUP_TASK_STATE.disabledByUser);

		// Windows の設定は、ApplicationFrameHost の「設定」の窓として前面に出る。開いたままだと
		// 後のトレイの操作の邪魔になるので閉じる (もとから開いていても、同じ窓が前面に来る)
		await waitFor(
			describeForegroundWindow,
			(text) => /title=(設定|Settings) process=ApplicationFrameHost/.test(text),
			{
				label: 'Windows の設定が前面に開く',
				timeout: 10000
			}
		);
		await closeSystemSettings();

		const pid = await getMawokProcessId();
		const { hwnd } = await openTrayMenu(pid);
		try {
			const items = await readTrayMenu(hwnd);
			const warning = items.find((item) => item.text.startsWith('⚠'));
			assert.ok(
				warning,
				`トレイのメニューに ⚠ がありません: ${items.map((item) => item.text).join(', ')}`
			);
			assert.ok(
				warning.text.includes(TURNED_OFF_IN_WINDOWS),
				`⚠ の理由が違います: ${warning.text}`
			);
		} finally {
			await closeTrayMenu(pid);
		}
		// 次のテストのために、有効にできる状態へ戻す
		await writeStartupTaskState(pkg, STARTUP_TASK_STATE.disabled);
	});

	test('「設定ファイルを表示」「ログを表示」が、EXE 版と同じ場所の実物を選んで開く', async () => {
		const config = await revealAndRead(CDP_PORT, 'reveal_config_file');
		assert.equal(config.folder, APP_DATA_DIRS.roaming);
		assert.deepEqual(config.selected, [path.join(APP_DATA_DIRS.roaming, 'config.toml')]);
		const log = await revealAndRead(CDP_PORT, 'reveal_log_file');
		assert.equal(log.folder, path.join(APP_DATA_DIRS.local, 'logs'));
		assert.deepEqual(log.selected, [path.join(APP_DATA_DIRS.local, 'logs', 'Mawok.log')]);
	});

	test('通知の差出人がパッケージになる', async () => {
		const aumid = appUserModelId(pkg);
		await clearToasts(aumid);
		const title = `MSIX 版の確認 ${Date.now()}`;
		try {
			await invokeOrThrow(CDP_PORT, 'notify_action_finished', { message: title });
			// 差出人がパッケージとして受け付けられた通知だけが、その AUMID の履歴に残る
			// (ポップアップは集中モードなどで出ないことがあるので、履歴で見る)
			await waitFor(
				() => readToastTitles(aumid),
				(titles) => titles.includes(title),
				{ label: `AUMID (${aumid}) の通知の履歴` }
			);
		} finally {
			await clearToasts(aumid);
		}
	});

	test('タスクバーのアイコンが下地に載らない', async () => {
		await invokeOrThrow(CDP_PORT, 'open_settings_window');
		const plate = await waitFor(
			() => measureTaskbarIconPlate('Mawok').catch(() => null),
			(result) => result !== null,
			{ label: 'タスクバーの Mawok のボタン' }
		);
		// 下地に載ると、アイコンの周りがアクセントの色で塗られる (Windows 11 の実機では、ボタンの13%ほど)。
		// 下地なしでは0だった
		assert.ok(
			plate.accent / plate.counted < 0.02,
			`タスクバーのボタンにアクセントの色が多く出ています (下地に載っている見込み): ${JSON.stringify(plate)}`
		);
	});
});

describe('EXE 版のファイルが無い環境', () => {
	let held;

	before(async () => {
		await stopMawok();
		held = await holdAppData();
		await launchInPackage(pkg, CDP_PORT);
		// 設定を1つ変えて、設定ファイルを作らせる
		await invokeOrThrow(CDP_PORT, 'set_language', { language: 'ja' });
	});

	after(async () => {
		try {
			await stopMawok();
			// 外したままならここで入れ直す (外した後の確かめで落ちたとき)
			if ((await readPackage()) === null) await addPackage(builtMsixPath());
			pkg = await readPackage();
		} finally {
			held?.restore();
		}
	});

	test('設定・ログは、パッケージごとの場所に回され、EXE 版の場所には何もできない', async () => {
		const redirected = redirectedDataDirs(pkg);
		await waitFor(
			() => fs.existsSync(path.join(redirected.roaming, 'config.toml')),
			(exists) => exists,
			{ label: '回された先の config.toml' }
		);
		assert.ok(fs.existsSync(path.join(redirected.local, 'logs', 'Mawok.log')));
		assert.equal(fs.existsSync(APP_DATA_DIRS.roaming), false);
		assert.equal(fs.existsSync(APP_DATA_DIRS.local), false);
	});

	test('「設定ファイルを表示」「ログを表示」が、回された先を選んで開く', async () => {
		const redirected = redirectedDataDirs(pkg);
		const config = await revealAndRead(CDP_PORT, 'reveal_config_file');
		assert.equal(config.folder, redirected.roaming);
		assert.deepEqual(config.selected, [path.join(redirected.roaming, 'config.toml')]);
		const log = await revealAndRead(CDP_PORT, 'reveal_log_file');
		assert.equal(log.folder, path.join(redirected.local, 'logs'));
		assert.deepEqual(log.selected, [path.join(redirected.local, 'logs', 'Mawok.log')]);
	});

	test('アンインストールで、パッケージごとの場所がまるごと消える', async () => {
		await stopMawok();
		const dataDir = packageDataDir(pkg);
		assert.ok(fs.existsSync(dataDir), `外す前に ${dataDir} がありません`);
		await removePackage();
		await waitFor(
			() => fs.existsSync(dataDir),
			(exists) => !exists,
			{ label: `${dataDir} が消える`, timeout: 15000 }
		);
		assert.equal(fs.existsSync(APP_DATA_DIRS.roaming), false);
		assert.equal(fs.existsSync(APP_DATA_DIRS.local), false);
	});
});
