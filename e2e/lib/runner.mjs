import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';

// 入口 (run.mjs・msix-run.mjs・macos-run.mjs・linux-run.mjs・linux-vm-run.mjs) で共通の、引数の読み方と子プロセスの動かし方。OS によらない

/**
 * 引数を、フラグとテストファイルに分ける。`flags` に無いフラグは落とす。`--nobuild` のような打ち間違いを
 * テストファイルの名前として黙って受け取ると、飛ばしたつもりでビルドが走り、しかも `tests/--nobuild.test.mjs` を探して落ちる
 *
 * @param {string[]} argv
 * @param {string[]} flags 使えるフラグ (`--no-build` など)
 * @returns {{ flags: Set<string>, tests: string[] }}
 */
export function parseArgs(argv, flags) {
	const given = new Set();
	const tests = [];
	for (const arg of argv) {
		if (flags.includes(arg)) given.add(arg);
		else if (arg.startsWith('-')) {
			throw new Error(`知らない引数です: ${arg} (使えるフラグは ${flags.join('・')})`);
		} else tests.push(arg);
	}
	return { flags: given, tests };
}

/**
 * 選んだテストを、回すファイルの並びにする。`draft` のように名前だけなら `<dir>/<名前>.test.mjs`、
 * パスやグロブならそのまま (グロブは `cwd` から展開する)。省略すると `dir` の下を全部回す。並びはファイル名順
 */
export function testFiles(dir, tests, cwd) {
	const patterns = tests.length === 0 ? [`${dir}/*.test.mjs`] : tests;
	const files = patterns.flatMap((arg) => {
		const pattern = /[\\/*?[\]{}]|\.mjs$/.test(arg) ? arg : `${dir}/${arg}.test.mjs`;
		return /[*?[\]{}]/.test(pattern) ? globSync(pattern, { cwd }) : [pattern];
	});
	// 前のファイルの後始末に頼るテストがあるので、選び方によらずファイル名順に回す
	return [...new Set(files)].sort();
}

/**
 * 標準入出力をそのまま流して子プロセスを動かし、終了コードを返す (シグナルで終わったら 1)。`env` は今の環境変数に足す分。
 * `input` は標準入力に流すストリームで、無ければ標準入力は `stdin` (既定はそのまま流す)
 */
export function run(command, args, cwd, env = {}, { input, stdin = 'inherit' } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: [input ? 'pipe' : stdin, 'inherit', 'inherit'],
			env: { ...process.env, ...env }
		});
		child.once('error', reject);
		child.once('exit', (code) => resolve(code ?? 1));
		if (input) input.pipe(child.stdin);
	});
}

let interrupted = false;

/**
 * テストファイルを1つずつ順に `node` で直接回し、終了コードを返す (どれかが落ちたら 1)。
 * `node --test` を通さないのは、Ctrl+C を受けた `node --test` がテストのプロセスをすぐ強制終了し、
 * テスト側の書き戻し (config.mjs の registerCrashRecovery) が途中で打ち切られるため (Node 24 で確認)。
 * 中断されたら、残りのファイルは回さない。`nodeArgs` は各ファイルの `node` に先に渡す引数 (`--import` など)
 */
export async function runTests(files, cwd, nodeArgs = []) {
	if (files.length === 0) {
		console.error('[e2e] 選んだテストに当たるファイルがありません');
		return 1;
	}
	const failed = [];
	for (const file of files) {
		const code = await run(process.execPath, [...nodeArgs, file], cwd);
		if (code !== 0) failed.push(file);
		if (interrupted) {
			console.error('[e2e] 中断したので、残りのテストファイルは回しません');
			return 1;
		}
	}
	if (failed.length > 0) {
		console.error(
			`[e2e] 落ちたテストファイル (${failed.length}/${files.length}): ${failed.join(', ')}`
		);
		return 1;
	}
	console.log(`[e2e] ${files.length} 個のテストファイルがすべて通りました`);
	return 0;
}

/**
 * Ctrl+C やコンソールの窓を閉じたときは、同じコンソールの子プロセス (テスト) にも届き、テスト側が後始末をして終わる。
 * 入口は先に終わらず、子プロセスを待ってから自分の後始末をする。テスト側の後始末が固まったときに抜けられるよう、
 * 2回目の Ctrl+C では待たずに終わる
 */
export function waitForChildOnInterrupt() {
	process.on('SIGINT', () => {
		if (interrupted) process.exit(130);
		interrupted = true;
	});
	process.on('SIGHUP', () => {
		interrupted = true;
	});
}
