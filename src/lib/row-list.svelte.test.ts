import { describe, expect, it, vi } from 'vitest';
import { RowList } from '#lib/row-list.svelte.ts';

type Item = { name: string; body: string };
const isBlank = (item: Item) => item.name === '' && item.body === '';
const item = (name: string, body = '') => ({ name, body });

function list(items: Item[]) {
	const save = vi.fn<(rows: Item[]) => Promise<unknown>>(() => Promise.resolve(undefined));
	return { rows: new RowList(items, save, isBlank, (row) => row.name), save };
}

describe('RowList の空の行', () => {
	it('写すときに、前に足したまま閉じた空の行を捨てる', () => {
		const { rows } = list([item('a'), item(''), item('b')]);
		expect(rows.rows.map((row) => row.name)).toEqual(['a', 'b']);
	});

	it('空の行が残っていれば、足さずにその行を返す', () => {
		const { rows } = list([item('a')]);
		const added = rows.addBlank(item(''));
		expect(rows.addBlank(item(''))).toBe(added);
		expect(rows.rows).toHaveLength(2);
	});

	it('空の行だけを捨てて保存する。空の行が無ければ保存しない', async () => {
		const { rows, save } = list([item('a')]);
		rows.dropBlanks();
		expect(save).not.toHaveBeenCalled();

		rows.addBlank(item(''));
		rows.dropBlanks();
		expect(rows.rows.map((row) => row.name)).toEqual(['a']);
		// 保存は重なると後の1回にまとまるので、最後に保存した並びを見る
		await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith([item('a')]));
	});
});

describe('RowList の保存と写し直し', () => {
	it('追加と並べ替えの後の並びを、画面用の key を落として保存する', async () => {
		const { rows, save } = list([item('一つ目'), item('二つ目')]);
		rows.add(item('新しい行'));
		rows.move(2, 0);
		await vi.waitFor(() =>
			expect(save).toHaveBeenLastCalledWith([item('新しい行'), item('一つ目'), item('二つ目')])
		);
	});

	it('途中に行が差し込まれても、key が重ならず、前からある行の key を保つ', () => {
		const { rows } = list([item('A'), item('B')]);
		const keys = new Map(rows.rows.map((row) => [row.name, row.key]));
		rows.recopy([item('A'), item('届いた行'), item('B')]);
		expect(rows.rows.map((row) => row.name)).toEqual(['A', '届いた行', 'B']);
		expect(new Set(rows.rows.map((row) => row.key)).size).toBe(3);
		expect(rows.rows.find((row) => row.name === 'A')?.key).toBe(keys.get('A'));
		expect(rows.rows.find((row) => row.name === 'B')?.key).toBe(keys.get('B'));
	});

	it('ほかで本文だけを変えた行は、名前で結んで key を保つ', () => {
		const { rows } = list([item('A', '前の本文'), item('B')]);
		const key = rows.rows[0].key;
		rows.recopy([item('B'), item('A', '新しい本文')]);
		expect(rows.rows[1]).toEqual({ ...item('A', '新しい本文'), key });
	});

	it('画面で変えた後でも写し直す。書きかけの空の行は残す', () => {
		const { rows } = list([item('A')]);
		const blank = rows.addBlank(item(''));
		rows.recopy([item('A'), item(''), item('B', '届いた行')]);
		expect(rows.rows.map((row) => row.name)).toEqual(['A', '', 'B']);
		expect(rows.rows[1].key).toBe(blank.key);
	});

	it('保存の答えを待つ間に写し直したら、写した並びを保存し直す', async () => {
		const { rows, save } = list([item('A')]);
		let answer: (value: undefined) => void = () => {};
		save.mockImplementationOnce(() => new Promise<undefined>((resolve) => (answer = resolve)));
		rows.rows[0].body = '書きかけ';
		rows.save();
		const received = [item('A'), item('B', '届いた行')];
		rows.recopy(received);
		answer(undefined);
		await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith(received));
	});

	it('届いた並びに無い、足した直後の行の key を、別の届いた行に渡さない', () => {
		const { rows, save } = list([item('A')]);
		save.mockImplementation(() => new Promise<undefined>(() => {}));
		const [added] = rows.add(item('書きかけ'));
		rows.recopy([item('A'), item('B', '届いた行')]);
		expect(rows.rows[1].key).not.toBe(added.key);
	});
});
