import test from 'node:test';
import {
	KEY,
	copyAndHide,
	draftState,
	holdUserState,
	keyCode,
	relaunchWithTestConfig,
	restoreUserState,
	showDraftWith,
	waitDraftValue
} from '../lib/macos.mjs';
import { waitFor } from '../lib/wait.mjs';

// 下書きの履歴を、折り返した文の ↑↓ で見る。カーソルが見た目の何行目にあるかは、入力欄の折り返しを
// WebView の描き方で測るので (src/lib/caret-line.ts)、WKWebView でも測れるかを見る。
// 改行の無い文の ↑↓ と、履歴の決まりの中身は Windows の E2E (tests/draft-history.test.mjs) に任せる

// 改行せずに、下書きウィンドウの幅で折り返して見た目が数行になる長さ。打つと時間がかかるので貼り付ける
const LONG = 'wrapped line '.repeat(40).trim();

/** キーを送り、入力欄の値が `value` のまま、カーソルが `moved` を満たすまで待つ */
async function pressAndWaitCaret(code, value, moved, label) {
	await keyCode(code);
	return waitFor(
		draftState,
		(s) =>
			s.value === value && Array.isArray(s.caret) && s.caret[0] === s.caret[1] && moved(s.caret[0]),
		{ label }
	);
}

test.describe('macOS: 下書きの履歴', () => {
	test.before(async () => {
		await holdUserState();
		await relaunchWithTestConfig('', { clearHistory: true });
		// 古い方から git status、折り返す長い文の順に履歴に入れる
		for (const text of ['git status', LONG]) {
			await showDraftWith(text, { paste: true });
			await copyAndHide(text);
		}
	});

	test.after(async () => {
		await restoreUserState();
	});

	test('折り返した文の ↑↓ は、見た目の行を移るだけで、端の行の端でだけ履歴を移る', async () => {
		await showDraftWith('kakikake');
		await keyCode(KEY.up);
		await waitFor(draftState, (s) => s.value === 'kakikake' && s.caret?.[0] === 0, {
			label: '1行の ↑ で先頭へ移る'
		});
		await keyCode(KEY.up);
		await waitFor(draftState, (s) => s.value === LONG && s.caret?.[0] === 0, {
			label: '先頭の ↑ で、折り返す長い文が出る'
		});

		// 1行目の途中から ↓ で見た目の2行目へ移り (最終行より上の ↓)、↑ で1行目の途中へ戻る。どちらも履歴は移らない
		for (let i = 0; i < 5; i++) await keyCode(KEY.right);
		await waitFor(draftState, (s) => s.caret?.[0] === 5, { label: '1行目の途中へ動かす' });
		const second = await pressAndWaitCaret(
			KEY.down,
			LONG,
			(position) => position > 5 && position < LONG.length,
			'1行目の ↓ で、見た目の2行目へ移る'
		);
		await pressAndWaitCaret(
			KEY.up,
			LONG,
			(position) => position > 0 && position < second.caret[0],
			'見た目の2行目の ↑ で、1行目の途中へ移る'
		);

		// 1行目の途中の ↑ は先頭へ移り、もう一度で古い履歴を出す
		await pressAndWaitCaret(
			KEY.up,
			LONG,
			(position) => position === 0,
			'1行目の途中の ↑ で先頭へ移る'
		);
		await keyCode(KEY.up);
		await waitDraftValue('git status');

		// 古い方へ移ると先頭に置かれるので、1回目の ↓ は末尾へ移るだけ。新しい方へ戻ると末尾に置かれる。
		// 最終行の途中へ動かし、↓ で末尾へ移ってから、もう一度で書きかけに戻る
		await pressAndWaitCaret(
			KEY.down,
			'git status',
			(position) => position === 'git status'.length,
			'1行の ↓ で末尾へ移る'
		);
		await keyCode(KEY.down);
		await waitFor(draftState, (s) => s.value === LONG && s.caret?.[0] === LONG.length, {
			label: '末尾の ↓ で、長い文が末尾にカーソルを置いて出る'
		});
		for (let i = 0; i < 3; i++) await keyCode(KEY.left);
		await pressAndWaitCaret(
			KEY.down,
			LONG,
			(position) => position === LONG.length,
			'最終行の途中の ↓ で末尾へ移る'
		);
		await keyCode(KEY.down);
		await waitDraftValue('kakikake');
	});
});
