// `just linux-check` の入口。Linux の自動の確認 (`linux/*.test.mjs`) を、Hyprland の上で回す。
//
// ビルドはしない。入れてある /usr/bin/mawok で回す (別のものは環境変数 MAWOK_APP で指す)。CI では回さない
// (runner に Wayland のデスクトップと portal が無いため)。
// 引数でテストファイルを選べる。`tray` のように名前だけなら `linux/<名前>.test.mjs`。
// `--restore` は、中断して残った控えから、常用の Mawok・ログイン時の起動・クリップボード・Hyprland の割り当てを戻すだけ
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, runTests, testFiles, waitForChildOnInterrupt } from './lib/runner.mjs';

if (process.platform !== 'linux') {
	console.error('[linux-check] Linux で回してください');
	process.exit(1);
}

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
let options;
try {
	options = parseArgs(process.argv.slice(2), ['--restore']);
} catch (error) {
	console.error(`[linux-check] ${error.message}`);
	process.exit(2);
}

const { FAILURE_DIR, ensureSessionEnv, holdUserState, preflight, restoreUserState } =
	await import('./lib/linux.mjs');

if (options.flags.has('--restore')) {
	await ensureSessionEnv();
	const restored = await restoreUserState();
	console.log(
		restored === null ? '[linux-check] 戻す控えはありません' : '[linux-check] 控えから戻しました'
	);
	process.exit(0);
}

try {
	await preflight();
} catch (error) {
	console.error(`[linux-check] ${error.message}`);
	process.exit(1);
}

// 中断されたら、テスト側の後始末を待ってから、利用者の状態を戻す
waitForChildOnInterrupt();
// 前の実行で落ちた時点の記録と混ざらないよう、回す前に空にする
await fs.rm(FAILURE_DIR, { recursive: true, force: true });
// 常用の Mawok と同時には動かせない (単一起動とホットキーが OS の上で1つ) ので、全体の前後で1度だけ止めて戻す
await holdUserState();
try {
	process.exitCode = await runTests(testFiles('linux', options.tests, e2eDir), e2eDir, [
		'--import',
		'./lib/linux-failure-capture.mjs'
	]);
} finally {
	try {
		await restoreUserState();
	} catch (error) {
		console.warn(
			`[linux-check] 利用者の状態を戻せませんでした (just linux-check --restore で戻せます): ${error.message}`
		);
	}
}
