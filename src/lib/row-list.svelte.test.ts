import { describe, expect, it, vi } from 'vitest';
import { RowList } from './row-list.svelte';

type Item = { name: string };
const isBlank = (item: Item) => item.name === '';

function list(items: Item[]) {
	const save = vi.fn(() => Promise.resolve());
	return { rows: new RowList(items, save, isBlank), save };
}

describe('RowList の空の行', () => {
	it('写すときに、前に足したまま閉じた空の行を捨てる', () => {
		const { rows } = list([{ name: 'a' }, { name: '' }, { name: 'b' }]);
		expect(rows.rows.map((row) => row.name)).toEqual(['a', 'b']);
	});

	it('空の行が残っていれば、足さずにその行を返す', () => {
		const { rows } = list([{ name: 'a' }]);
		const added = rows.addBlank({ name: '' });
		expect(rows.addBlank({ name: '' })).toBe(added);
		expect(rows.rows).toHaveLength(2);
	});

	it('空の行だけを捨てて保存する。空の行が無ければ保存しない', async () => {
		const { rows, save } = list([{ name: 'a' }]);
		rows.dropBlanks();
		expect(save).not.toHaveBeenCalled();

		rows.addBlank({ name: '' });
		rows.dropBlanks();
		expect(rows.rows.map((row) => row.name)).toEqual(['a']);
		// 保存は重なると後の1回にまとまるので、最後に保存した並びを見る
		await vi.waitFor(() =>
			expect(save).toHaveBeenLastCalledWith([expect.objectContaining({ name: 'a' })])
		);
	});
});
