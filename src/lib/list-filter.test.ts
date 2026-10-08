import { describe, expect, it } from 'vitest';
import { matchedIds, matchesFilter, shownRows, showsFilter } from './list-filter';

describe('matchesFilter', () => {
	it('どれかの文字列が語を含めば当たり、英字の大文字と小文字は区別しない', () => {
		expect(matchesFilter('GIT', '確認', 'git status')).toBe(true);
		expect(matchesFilter('diff', '確認', 'git status')).toBe(false);
	});

	it('英字以外の文字の違いは揃えない（全角の英字は半角と別の文字）', () => {
		expect(matchesFilter('ｇｉｔ', 'Ｇｉｔ')).toBe(false);
	});

	it('語の前後の空白は除き、空の語なら絞り込まない', () => {
		expect(matchesFilter(' git ', 'git status')).toBe(true);
		expect(matchesFilter('  ', 'git status')).toBe(true);
	});
});

describe('matchedIds と shownRows', () => {
	const rows = [
		{ id: 'a', text: '確認' },
		{ id: 'b', text: 'git status' }
	];

	it('語が空白だけなら絞り込まず、すべてを出す', () => {
		const ids = matchedIds(
			() => rows,
			' ',
			(row) => [row.text]
		);
		expect(ids).toBeNull();
		expect(shownRows(rows, ids)).toEqual(rows);
	});

	it('当たった行だけを、並びのまま出す', () => {
		const ids = matchedIds(
			() => rows,
			'git',
			(row) => [row.text]
		);
		expect(shownRows(rows, ids)).toEqual([rows[1]]);
	});
});

describe('showsFilter', () => {
	it('6件から欄を出し、語が残っている間は件数が減っても出し続ける', () => {
		expect(showsFilter(5, '')).toBe(false);
		expect(showsFilter(6, '')).toBe(true);
		expect(showsFilter(0, 'git')).toBe(true);
	});
});
