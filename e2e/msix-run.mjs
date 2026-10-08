// `just msix-check` の入口。画面がロック・スタンバイ中でないことを確かめ、終わるまで画面を点けたまま、
// `just msix` で MSIX を作り直してから、MSIX 版の確認 (msix/*.test.mjs) を回す。
// `--no-build` を付けると、作り直さずに前に作った MSIX で回す (run.mjs と同じく、新しさでは自動で判断しない)。
// 引数でテストファイルを選べる (`msix` のように名前だけなら `msix/<名前>.test.mjs`)。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSessionReady, keepDisplayOn } from './lib/power.mjs';
import { stopPowerShell } from './lib/os.mjs';
import { parseArgs, run, runTests, testFiles, waitForChildOnInterrupt } from './lib/runner.mjs';

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(e2eDir, '..');

let options;
try {
	options = parseArgs(process.argv.slice(2), ['--no-build']);
} catch (error) {
	console.error(`[msix] ${error.message}`);
	process.exit(2);
}

// 中断されたら、テスト側が設定を書き戻し、退かしたフォルダーを戻して終わるのを待つ
waitForChildOnInterrupt();

await ensureSessionReady();
await stopPowerShell();
const display = await keepDisplayOn();
try {
	let code = options.flags.has('--no-build') ? 0 : await run('just', ['msix'], repoRoot);
	if (code === 0) code = await runTests(testFiles('msix', options.tests, e2eDir), e2eDir);
	process.exitCode = code;
} finally {
	await display.release();
}
