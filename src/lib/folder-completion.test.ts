import { describe, expect, it } from 'vitest';
import { stepSelection, suggestionSuffix } from './folder-completion';

const completion = (input: string, candidates: string[] = []) => ({
	input,
	base: '',
	candidates,
	total: candidates.length
});

describe('suggestionSuffix', () => {
	it('1つに決まれば、打った所より先を返す', () => {
		expect(suggestionSuffix('~/Wo', completion('~/Works/'))).toBe('rks/');
	});

	it('打った所と書き方が違っても、続きとみなす', () => {
		expect(suggestionSuffix('wo', completion('Works/'))).toBe('rks/');
	});

	it('候補が複数、補えない、打った所と食い違うときは出さない', () => {
		expect(suggestionSuffix('D', completion('D', ['Desktop/', 'Documents/']))).toBe('');
		expect(suggestionSuffix('Do', completion('Documents', ['Documents/', 'Documents-old/']))).toBe(
			''
		);
		expect(suggestionSuffix('nowhere', completion('nowhere'))).toBe('');
		expect(suggestionSuffix('"~/Wo', completion('~/Works/'))).toBe('');
	});
});

describe('stepSelection', () => {
	it('まだ選んでいなければ、進むなら先頭、戻るなら末尾を選ぶ', () => {
		expect(stepSelection(-1, 3, 1)).toBe(0);
		expect(stepSelection(-1, 3, -1)).toBe(2);
	});

	it('端の先は反対の端へ回る', () => {
		expect(stepSelection(2, 3, 1)).toBe(0);
		expect(stepSelection(0, 3, -1)).toBe(2);
		expect(stepSelection(1, 3, 1)).toBe(2);
	});

	it('候補が無ければ選ばない', () => {
		expect(stepSelection(-1, 0, 1)).toBe(-1);
	});
});
