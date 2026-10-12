import { describe, expect, it } from 'vitest';
import type { AccountStatus } from '$lib/bindings/AccountStatus';
import { m } from '$lib/paraglide/messages';
import { mawokRemainingText } from './mawok-account';

describe('mawokRemainingText', () => {
	it('様子が分かっていれば、残りの割合を出す', () => {
		const status = { remainingPercent: 40 } as AccountStatus;
		expect(mawokRemainingText(status)).toBe(m.settings_mawok_remaining({ percent: 40 }));
	});

	it('使い切った 0 も、残りの割合として出す', () => {
		const status = { remainingPercent: 0 } as AccountStatus;
		expect(mawokRemainingText(status)).toBe(m.settings_mawok_remaining({ percent: 0 }));
	});

	it('確かめられなかったらその旨を、答えを待っている間は何も出さない', () => {
		expect(mawokRemainingText(null)).toBe(m.settings_mawok_status_unknown());
		expect(mawokRemainingText(undefined)).toBe('');
	});
});
