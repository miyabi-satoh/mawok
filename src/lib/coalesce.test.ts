import { describe, expect, it } from 'vitest';
import { coalesced } from '#lib/coalesce.ts';

/** 呼ばれた回数を数え、1回ずつ手で終わらせられる処理 */
function controlled() {
	const finishes: (() => void)[] = [];
	const run = () => new Promise<void>((resolve) => finishes.push(resolve));
	return { run, finishes };
}

describe('coalesced', () => {
	it('走っている間に何度呼ばれても、終わってからもう一度だけ走らせる', async () => {
		const { run, finishes } = controlled();
		const call = coalesced(run);

		const first = call();
		call();
		call();
		expect(finishes).toHaveLength(1);

		finishes[0]();
		await Promise.resolve();
		await Promise.resolve();
		expect(finishes).toHaveLength(2);

		finishes[1]();
		await first;
		expect(finishes).toHaveLength(2);
	});

	it('走っている間に呼んだ Promise は、もう一度の分まで終わると解ける', async () => {
		const { run, finishes } = controlled();
		const call = coalesced(run);
		call();
		let settled = false;
		const second = call().then(() => (settled = true));

		finishes[0]();
		await new Promise((resolve) => setTimeout(resolve));
		expect(settled).toBe(false);

		finishes[1]();
		await second;
		expect(settled).toBe(true);
	});

	it('終わった後に呼べば、また新しく走らせる', async () => {
		const { run, finishes } = controlled();
		const call = coalesced(run);
		const first = call();
		finishes[0]();
		await first;

		call();
		expect(finishes).toHaveLength(2);
	});
});
