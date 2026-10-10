import { describe, expect, it, vi } from 'vitest';
import { RowList } from './row-list.svelte';

type Item = { id: string; name: string };
const isBlank = (item: Item) => item.name === '';

function list(items: Item[]) {
	const save = vi.fn<(rows: Item[]) => Promise<Item[] | undefined>>(() =>
		Promise.resolve(undefined)
	);
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

	it('途中に行が差し込まれても、key が重ならず、前からある行の key を保つ', () => {
		const { rows } = list([
			{ id: 'a', name: 'A' },
			{ id: 'b', name: 'B' }
		]);
		const keys = new Map(rows.rows.map((row) => [row.id, row.key]));
		rows.recopy(
			[
				{ id: 'a', name: 'A' },
				{ id: 'inserted', name: '届いた行' },
				{ id: 'b', name: 'B' }
			],
			true
		);
		expect(rows.rows.map((row) => row.name)).toEqual(['A', '届いた行', 'B']);
		expect(new Set(rows.rows.map((row) => row.key)).size).toBe(3);
		expect(rows.rows.find((row) => row.id === 'a')?.key).toBe(keys.get('a'));
		expect(rows.rows.find((row) => row.id === 'b')?.key).toBe(keys.get('b'));
	});

	it('画面で変えた後は、force を付けたときだけ写し直す。書きかけの空の行は残す', async () => {
		const { rows, save } = list([{ id: 'a', name: 'A' }]);
		save.mockImplementation((submitted: Item[]) =>
			Promise.resolve(submitted.map((row) => ({ ...row, id: row.id || 'blank' })))
		);
		const blank = rows.addBlank({ id: '', name: '' });
		await vi.waitFor(() => expect(rows.rows[1].id).toBe('blank'));
		const received = [
			{ id: 'a', name: 'A' },
			{ id: 'blank', name: '' },
			{ id: 'b', name: '届いた行' }
		];
		rows.recopy(received);
		expect(rows.rows).toHaveLength(2);
		rows.recopy(received, true);
		expect(rows.rows.map((row) => row.id)).toEqual(['a', 'blank', 'b']);
		expect(rows.rows[1].key).toBe(blank.key);
	});

	it('保存の答えを待つ間に写し直したら、写した並びを保存し直す', async () => {
		const { rows, save } = list([{ id: 'a', name: 'A' }]);
		let answer: (value: undefined) => void = () => {};
		save.mockImplementationOnce(() => new Promise<undefined>((resolve) => (answer = resolve)));
		rows.rows[0].name = 'A2';
		rows.save();
		const received = [
			{ id: 'a', name: 'A' },
			{ id: 'b', name: '届いた行' }
		];
		rows.recopy(received, true);
		answer(undefined);
		await vi.waitFor(() =>
			expect(save).toHaveBeenLastCalledWith(received.map((row) => expect.objectContaining(row)))
		);
	});
});
