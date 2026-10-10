import { describe, expect, it, vi } from 'vitest';
import { RowList } from './row-list.svelte';

type Item = { id: string; name: string };
const isBlank = (item: Item) => item.name === '';

function list(items: Item[]) {
	const save = vi.fn(() => Promise.resolve(undefined));
	return { rows: new RowList(items, save, isBlank), save };
}

describe('RowList の空の行', () => {
	it('写すときに、前に足したまま閉じた空の行を捨てる', () => {
		const { rows } = list([
			{ id: 'a', name: 'a' },
			{ id: 'blank', name: '' },
			{ id: 'b', name: 'b' }
		]);
		expect(rows.rows.map((row) => row.name)).toEqual(['a', 'b']);
	});

	it('空の行が残っていれば、足さずにその行を返す', () => {
		const { rows } = list([{ id: 'a', name: 'a' }]);
		const added = rows.addBlank({ id: '', name: '' });
		expect(rows.addBlank({ id: '', name: '' })).toBe(added);
		expect(rows.rows).toHaveLength(2);
	});

	it('空の行だけを捨てて保存する。空の行が無ければ保存しない', async () => {
		const { rows, save } = list([{ id: 'a', name: 'a' }]);
		rows.dropBlanks();
		expect(save).not.toHaveBeenCalled();

		rows.addBlank({ id: '', name: '' });
		rows.dropBlanks();
		expect(rows.rows.map((row) => row.name)).toEqual(['a']);
		// 保存は重なると後の1回にまとまるので、最後に保存した並びを見る
		await vi.waitFor(() =>
			expect(save).toHaveBeenLastCalledWith([expect.objectContaining({ name: 'a' })])
		);
	});

	it('追加と並べ替えで設定の ID と同期の値を保つ', async () => {
		type SyncedItem = { id: string; name: string; sync: boolean };
		const save = vi.fn((items: Array<SyncedItem & { key: string }>) =>
			Promise.resolve(items.map((item) => ({ ...item, id: item.id || 'created-by-rust' })))
		);
		const rows = new RowList<SyncedItem>(
			[
				{ id: 'first', name: '一つ目', sync: false },
				{ id: 'second', name: '二つ目', sync: true }
			],
			save,
			(item) => item.name === ''
		);

		rows.add({ id: '', name: '新しい行', sync: true });
		rows.move(2, 0);

		await vi.waitFor(() => expect(rows.rows[0].id).toBe('created-by-rust'));
		expect(rows.rows.map(({ id, sync }) => ({ id, sync }))).toEqual([
			{ id: 'created-by-rust', sync: true },
			{ id: 'first', sync: false },
			{ id: 'second', sync: true }
		]);
		await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith(rows.rows));
	});
});
