import { describe, expect, it } from 'vitest';
import { checkingPurchasePage, homePage } from '../src/pages';

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

describe('checkingPurchasePage', () => {
	const checking = async (pro: boolean, autoRetry: boolean) =>
		String(await checkingPurchasePage('ja', pro, '/account/buy/done?tries=1', autoRetry));

	it('names what is being bought in the title and the heading', async () => {
		const credits = await checking(false, true);
		expect(credits).toContain('<title>クレジットを購入 - Mawok</title>');
		expect(credits).toContain('<h1>クレジットを購入</h1>');
		const pro = await checking(true, true);
		expect(pro).toContain('<title>Mawok Pro - Mawok</title>');
		expect(pro).toContain('<h1>Mawok Pro</h1>');
	});

	it('reloads while it waits, and offers a manual check once it gives up', async () => {
		expect(await checking(false, true)).toContain('支払いを確かめています');
		expect(await checking(true, true)).toContain('申し込みを確かめています');
		for (const pro of [false, true]) {
			expect(await checking(pro, true)).toContain('http-equiv="refresh"');
			const gaveUp = await checking(pro, false);
			expect(gaveUp).not.toContain('http-equiv="refresh"');
			expect(gaveUp).toContain('もう一度確かめる');
		}
	});

	// Pro は試用で始まると支払いも領収のメールも無いので、領収のメールの案内はクレジットだけに出す。
	it('points to the receipt email only for a credit purchase', async () => {
		expect(await checking(false, false)).toContain('買い直す前に、領収のメール');
		const pro = await checking(true, false);
		expect(pro).toContain('申し込みをまだ確かめられていません');
		expect(pro).not.toContain('領収のメール');
	});
});
