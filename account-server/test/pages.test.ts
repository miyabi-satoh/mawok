import { describe, expect, it } from 'vitest';
import { homePage } from '../src/pages';

describe('homePage', () => {
	const home = async (remaining: number, percent: number) =>
		String(await homePage('ja', 'a@example.com', { remaining, percent }, [], undefined));

	it('shows what is left as a percentage, or that nothing is left', async () => {
		expect(await home(1, 1)).toContain('AI アクションのクレジット: 残り 1%');
		expect(await home(0, 0)).toContain('AI アクションのクレジットはありません');
	});
});
