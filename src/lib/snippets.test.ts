import { describe, expect, it } from 'vitest';
import { filterSnippets, snippetLabel, snippetPreview } from './snippets';

const review = {
	name: 'レビュー依頼',
	body: '次の差分をレビューしてください。\n指摘は重要度の高い順に。'
};
const status = { name: '', body: '\n  \ngit status\ngit diff' };
const empty = { name: '空の定型文', body: '' };

describe('snippetLabel と snippetPreview', () => {
	it('名前があれば名前を見出しにし、本文の1行目を添える', () => {
		expect(snippetLabel(review)).toBe('レビュー依頼');
		expect(snippetPreview(review)).toBe('次の差分をレビューしてください。');
	});

	it('名前が空なら、本文の最初の空でない行を見出しにし、同じ行を重ねて添えない', () => {
		expect(snippetLabel(status)).toBe('git status');
		expect(snippetPreview(status)).toBe('');
	});

	it('空白だけの名前は空とみなす', () => {
		expect(snippetLabel({ name: '  ', body: 'git status' })).toBe('git status');
	});

	it('Windows の改行でも行を分ける', () => {
		expect(snippetPreview({ name: '確認', body: '1行目\r\n2行目' })).toBe('1行目');
	});
});

describe('filterSnippets', () => {
	const snippets = [review, status, empty];

	it('絞り込みが空なら、本文が空のものを除いて登録した順に出す', () => {
		expect(filterSnippets(snippets, '')).toEqual([review, status]);
	});

	it('名前か本文のどこかに含まれるものだけを残す', () => {
		expect(filterSnippets(snippets, '依頼')).toEqual([review]);
		expect(filterSnippets(snippets, 'diff')).toEqual([status]);
		// 本文の2行目にあっても当たる
		expect(filterSnippets(snippets, '重要度')).toEqual([review]);
	});

	it('本文が空のものは、名前が当たっても出さない', () => {
		expect(filterSnippets(snippets, '空の')).toEqual([]);
	});

	it('英字の大文字と小文字は区別しない', () => {
		expect(filterSnippets(snippets, 'GIT')).toEqual([status]);
		expect(filterSnippets([{ name: 'README', body: 'x' }], 'readme')).toHaveLength(1);
	});

	it('英字以外の文字の違いは揃えない', () => {
		// 全角の英字は、半角と別の文字として扱う
		expect(filterSnippets(snippets, 'ｇｉｔ')).toEqual([]);
	});

	it('語の前後の空白は除く', () => {
		expect(filterSnippets(snippets, ' 依頼 ')).toEqual([review]);
	});

	it('文字が飛び飛びに含まれるだけでは当てない（あいまい一致にしない）', () => {
		expect(filterSnippets(snippets, 'レ依')).toEqual([]);
	});

	it('並びは当たり方に関わらず、登録した順のまま', () => {
		const first = { name: 'あとで', body: 'git を使う' };
		const second = { name: 'git', body: '先頭で当たる' };
		expect(filterSnippets([first, second], 'git')).toEqual([first, second]);
	});
});
