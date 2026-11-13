// macos-run.mjs が各テストファイルの前に `--import` で読み込む。どのテストが落ちても、
// 後始末で窓が動く前に、落ちた時点の画面と窓の一覧を残す (テストファイルごとに書かずに済むよう、ここで全体に掛ける)
import { afterEach } from 'node:test';
import { captureFailure } from './macos.mjs';

afterEach(async (t) => {
	if (t.passed) return;
	const saved = await captureFailure(t.fullName);
	if (saved.length > 0) console.error(`[macos-check] 落ちた時点の記録: ${saved.join(', ')}`);
});
