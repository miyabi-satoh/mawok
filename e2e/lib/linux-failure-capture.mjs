// linux-run.mjs が各テストファイルの前に `--import` で読み込む。テストの本体が落ちたら、テストファイルの後始末 (test.after) で
// Mawok を閉じる前に、その時点の画面と窓の一覧を残す (テストファイルごとに書かずに済むよう、ここで全体に掛ける)
import { afterEach } from 'node:test';
import { captureFailure } from './linux.mjs';

afterEach(async (t) => {
	if (!t.error) return;
	const saved = await captureFailure(t.fullName);
	if (saved.length > 0) console.error(`[linux-check] 落ちた時点の記録: ${saved.join(', ')}`);
});
