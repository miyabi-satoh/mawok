import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { PROFILE, PROFILE_ENV } from './app-conf.mjs';

const execFileAsync = promisify(execFile);

/** ポートが既に何かに使われていないか確認する (前回の実行が残した msedgedriver 等) */
function checkPortFree(port) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ port, host: '127.0.0.1' });
		socket.once('connect', () => {
			socket.destroy();
			reject(
				new Error(
					`ポート ${port} は既に何かに使われています。前回の tauri-driver / msedgedriver が` +
						'残っている可能性があります。tasklist で tauri-driver.exe / msedgedriver.exe を確認し、' +
						'残っていれば終了してから再実行してください。'
				)
			);
		});
		socket.once('error', () => {
			socket.destroy();
			resolve();
		});
	});
}

/** ポートが接続を受けているか */
function isListening(port) {
	return new Promise((resolve) => {
		const socket = net.createConnection({ port, host: '127.0.0.1' });
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => {
			socket.destroy();
			resolve(false);
		});
	});
}

/**
 * tauri-driver (と、その内部で使う msedgedriver) を起動する。
 * リポジトリ直下の msedgedriver.exe を使う想定 (msedgedriver-tool で用意し、WebView2 のバージョンに合わせる)。
 *
 * @param {{ port?: number, nativePort?: number, msedgedriverPath: string }} options
 * @returns {Promise<{ port: number, stop: () => Promise<void> }>}
 */
export async function startTauriDriver({ port = 4444, nativePort = 9515, msedgedriverPath }) {
	await checkPortFree(port);
	await checkPortFree(nativePort);

	return new Promise((resolve, reject) => {
		const child = spawn(
			'tauri-driver',
			[
				'--port',
				String(port),
				'--native-port',
				String(nativePort),
				'--native-driver',
				msedgedriverPath
			],
			// アプリは tauri-driver → msedgedriver の順に環境変数を引き継ぐので、ここで渡せばアプリまで届く。
			// プロファイルを分けて、常用のアカウントで同期しない・常用の設定と履歴に触れないようにする (src-tauri/src/profile.rs)
			{ stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, [PROFILE_ENV]: PROFILE } }
		);

		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			// プロセスツリーが実際に終了するのを待ってから reject する。待たずに reject すると、
			// 呼び出し元がすぐ次の起動を試みたときに msedgedriver がポートを塞いだままになりうる
			stopProcessTree(child).finally(() => {
				reject(new Error('tauri-driver がタイムアウト内に起動しませんでした'));
			});
		}, 15_000);

		// tauri-driver 2.0.5 以降は msedgedriver の標準出力を捨て、起動を知らせる行が届かない。
		// tauri-driver が受けるポートと、msedgedriver が受けるポートの両方がつながるまで待つ
		const poll = async () => {
			while (!settled) {
				if ((await isListening(port)) && (await isListening(nativePort))) {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					resolve({
						port,
						stop: () => stopProcessTree(child)
					});
					return;
				}
				await new Promise((wake) => setTimeout(wake, 200));
			}
		};
		void poll();

		child.on('error', (error) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				reject(error);
			}
		});

		child.on('exit', (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				reject(new Error(`tauri-driver が起動前に終了しました (code=${code})`));
			}
		});
	});
}

/**
 * tauri-driver とその子プロセス (msedgedriver) をまとめて終了し、実際に終了するまで待つ。
 *
 * `child.kill()` だけだと tauri-driver 自身は終わっても子の msedgedriver が残ることがあり、
 * ポート (4444/9515) が塞がったまま次回の起動が失敗する原因になるため、`taskkill /T` で
 * プロセスツリーごと終了し、`exit` イベントを待ってから返す
 */
async function stopProcessTree(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once('exit', resolve));
	try {
		await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
	} catch {
		// 既に終了していた場合などは taskkill がエラーを返すが、それでよい
	}
	await exited;
}
