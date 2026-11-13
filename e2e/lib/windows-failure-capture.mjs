// run.mjs と msix-run.mjs が各テストファイルの前に `--import` で読み込む。テストの本体が落ちたら、ファイルの後始末 (test.after) で
// アプリを閉じる前に、その時点の画面と窓の一覧を残す (テストファイルごとに書かずに済むよう、ここで全体に掛ける)。
// 本体の中の finally で閉じた窓は、もう写らない
import { afterEach } from 'node:test';
import { captureFailure } from './os.mjs';

afterEach(async (t) => {
	if (t.passed) return;
	const saved = await captureFailure(t.fullName);
	if (saved.length > 0) console.error(`[e2e] 落ちた時点の記録: ${saved.join(', ')}`);
});
