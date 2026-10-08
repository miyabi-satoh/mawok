/**
 * 値が変わるまで待つ (クリップボードや window handle のように非同期に変化する状態を、
 * 固定の sleep 一発で読まずにポーリングする)。タイムアウトしたら最後に読んだ値を含めて失敗させる。
 *
 * @param {() => Promise<unknown>} read
 * @param {(value: unknown) => boolean} predicate
 * @param {{ timeout?: number, interval?: number, label?: string }} [options]
 */
export async function waitFor(read, predicate, { timeout = 5000, interval = 100, label } = {}) {
	const deadline = Date.now() + timeout;
	let last;
	for (;;) {
		last = await read();
		if (predicate(last)) return last;
		if (Date.now() > deadline) {
			const what = label ? `${label} ` : '';
			throw new Error(
				`${what}がタイムアウトまでに条件を満たしませんでした (最後の値: ${JSON.stringify(last)})`
			);
		}
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
}

/**
 * `read()` が `expected` のまま、`duration` ミリ秒のあいだ変わらないことを確かめる
 * (「押しても何も起きない」を見るときに使う)。変わったら、その場で失敗させる。
 *
 * 1回読むのにも時間がかかる (PowerShell で Win32 を読むなど) ので、期限を過ぎてからもう1回読み、
 * 期限の終わりまでの状態を取りこぼさない
 *
 * @param {() => Promise<unknown>} read
 * @param {unknown} expected
 * @param {{ label: string, duration?: number }} options
 */
export async function expectStays(read, expected, { label, duration = 1000 }) {
	const deadline = Date.now() + duration;
	for (;;) {
		const pastDeadline = Date.now() >= deadline;
		const actual = await read();
		if (actual !== expected) {
			throw new Error(
				`${label}: ${JSON.stringify(expected)} のままのはずが ${JSON.stringify(actual)} になりました`
			);
		}
		if (pastDeadline) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
