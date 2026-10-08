// `just macos-check` の入口。macOS の自動の確認 (`macos/*.test.mjs`) を回す。
//
// ビルドはしない。常用の /Applications/Mawok.app で回す (別のものは環境変数 MAWOK_APP で指す)。
// 引数でテストファイルを選べる。`draft` のように名前だけなら `macos/<名前>.test.mjs`。
// `--restore` は、中断して残った控えから、設定・履歴・クリップボードなどを戻すだけ
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, runTests, testFiles } from './lib/runner.mjs';

if (process.platform !== 'darwin') {
	console.error('[macos-check] macOS で回してください');
	process.exit(1);
}

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
let options;
try {
	options = parseArgs(process.argv.slice(2), ['--restore']);
} catch (error) {
	console.error(`[macos-check] ${error.message}`);
	process.exit(2);
}

const { assertPermissions, restoreUserState } = await import('./lib/macos.mjs');
try {
	// 戻すときも、利用者の状態に合わせて Mawok を起動し直し、メニューバーのアイコンをアクセシビリティで待つ
	await assertPermissions({ screenCapture: !options.flags.has('--restore') });
} catch (error) {
	console.error(`[macos-check] ${error.message}`);
	process.exit(1);
}

// 中断して控えが残ったときに、テストを回さずに戻す (Ctrl+C では後始末が走らない)
if (options.flags.has('--restore')) {
	const restored = await restoreUserState();
	console.log(
		restored === null ? '[macos-check] 戻す控えはありません' : '[macos-check] 控えから戻しました'
	);
	process.exit(0);
}

process.exitCode = await runTests(testFiles('macos', options.tests, e2eDir), e2eDir);
