import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTauriDriver } from './tauri-driver.mjs';
import {
	AUTOSTART_HELD_ENV,
	ensureMawokNotRunning,
	recoverStaleAppsThemeIfAny,
	recoverStaleAutostartBackupIfAny,
	snapshotAutostartEntry,
	stopPowerShell
} from './os.mjs';
import { launchApp } from './app.mjs';
import {
	acquireLock,
	releaseLock,
	recoverStaleBackupIfAny,
	registerCrashRecovery
} from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MSEDGEDRIVER_PATH = path.resolve(__dirname, '..', '..', 'msedgedriver.exe');

/**
 * 1テストファイルぶんの前後処理をまとめる。
 * - 実行の排他ロックを取る (2つの `just e2e` が同時に config.toml を取り合わないため)
 * - 前回の実行が中断されて config.toml やログイン時の起動の登録の控えが残っていれば書き戻し、以後の中断にも備える。
 *   登録の控えと書き戻しは、run.mjs を通さずに回すときだけ行う (`just e2e` では run.mjs が全体の前後で1度だけ行う)
 * - 常用の Mawok が動いていないことを確認する (動いていれば、書きかけの下書きを消さないよう
 *   黙って終了せず、手動で閉じてもらうようはっきり失敗する)
 * - tauri-driver を起動する
 * - テストごとに新しい Mawok インスタンスを起動して WebDriver セッションに繋ぎ、画面の読み込みを待つ
 *
 * @returns {{
 *   before: () => Promise<void>,
 *   after: () => Promise<void>,
 *   newClient: (options?: { waitForPage?: boolean }) => Promise<WebdriverIO.Browser>,
 *   closeClient: (client: WebdriverIO.Browser) => Promise<void>,
 * }}
 */
export function createSuite() {
	let driver;
	let lockToken;
	let autostart;

	async function closeClient(client) {
		try {
			await client.deleteSession();
		} catch {
			// セッションが既に切れていてもよい
		}
		// deleteSession() で Mawok プロセスも終了するはず。残っていたら
		// 後始末が失敗しているということなので、次のテストに進む前に気づけるようにする
		await ensureMawokNotRunning();
	}

	return {
		async before() {
			lockToken = await acquireLock();
			await recoverStaleBackupIfAny();
			await recoverStaleAppsThemeIfAny();
			// run.mjs から回すときは、run.mjs が全体の前後で1度だけ控えて戻す (AUTOSTART_HELD_ENV)。
			// そのときの控えのファイルは run.mjs のもので、ここで書き戻してはいけない
			const held = process.env[AUTOSTART_HELD_ENV] === '1';
			if (!held) await recoverStaleAutostartBackupIfAny();
			registerCrashRecovery(lockToken);
			await ensureMawokNotRunning();
			// E2E が起動するアプリは、設定や OS の登録しだいで、ログイン時の起動を E2E の実行ファイルのパスで登録し直す
			// (設定ファイルに autostart がなければ既定はオン)。run.mjs を通さずに回すときは、テストファイルごとに控えて戻す
			if (!held) autostart = await snapshotAutostartEntry();
			driver = await startTauriDriver({ msedgedriverPath: MSEDGEDRIVER_PATH });
		},
		async after() {
			try {
				await driver?.stop();
			} finally {
				try {
					await autostart?.restore();
				} finally {
					await releaseLock(lockToken);
					await stopPowerShell();
				}
			}
		},
		/**
		 * 既定では、画面の読み込みを待つため、下書きの入力欄が出るまで待ってから返す (DOM で見るので、
		 * ネイティブのウィンドウが隠れていても通る)。`waitForPage: false` は、初めての起動のように
		 * 起動した直後の振る舞いを、読み込みを待つ前から見るときに使う
		 */
		async newClient({ waitForPage = true } = {}) {
			// 前のテストの後始末 (closeClient) が確実に終わっている前提だが、
			// 万一まだ残っていたら黙って殺さずここで気づけるようにする
			await ensureMawokNotRunning();
			const client = await launchApp({ port: driver.port });
			if (!waitForPage) return client;
			try {
				await client.$('textarea').waitForDisplayed({ timeout: 5000 });
			} catch (error) {
				// 呼ぶ側に client が渡らず後始末できないので、ここで閉じてから投げる
				await closeClient(client).catch(() => {});
				throw error;
			}
			return client;
		},
		closeClient
	};
}
