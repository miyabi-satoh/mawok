import { describe, expect, it } from 'vitest';
import { homePage } from '../src/pages';

describe('homePage', () => {
	const home = async (remaining: number, percent: number) =>
		String(await homePage('ja', 'a@example.com', { remaining, percent }, [], undefined));

	it('shows what is left as a percentage, or that nothing is left', async () => {
		expect(await home(1, 1)).toContain('AI アクションのクレジット: 残り 1%');
		expect(await home(0, 0)).toContain('AI アクションのクレジットはありません');
	});

	it('says a canceled trial will not be charged in English', async () => {
		const page = String(
			await homePage('en', 'a@example.com', { remaining: 1, percent: 1 }, [], 'domestic', {
				pro: {
					active: true,
					until: 2_000_000_000,
					plan: 'monthly',
					trial: true,
					renews: false,
					displayUntil: 2_000_000_000
				}
			})
		);
		expect(page).toContain('Your trial lasts until');
		expect(page).toContain('You will not be charged.');
	});
});
