import { describe, expect, it } from 'vitest';
import { historyItems, historyPreview } from '#lib/history-search.ts';

describe('historyItems', () => {
	it('新しいものから並べ、同じ本文は新しい方だけを残す', () => {
		expect(historyItems(['git status', 'git diff', 'git status', 'git log'])).toEqual([
			{ name: '', body: 'git log', index: 3 },
			{ name: '', body: 'git status', index: 2 },
			{ name: '', body: 'git diff', index: 1 }
		]);
	});
});

describe('historyPreview', () => {
	it('見出しの行に当たらず、ほかの行に当たったときだけ、その行を添える', () => {
		const body = 'コミットして\n\n  git push origin main\nPR を作る';

		expect(historyPreview(body, '')).toBe('');
		expect(historyPreview(body, 'コミット')).toBe('');
		expect(historyPreview(body, 'PUSH')).toBe('git push origin main');
		expect(historyPreview(body, 'PR')).toBe('PR を作る');
	});
});
