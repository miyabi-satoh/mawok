import { describe, expect, it } from 'vitest';
import { checkingPurchasePage, homePage, proConfirmPage } from '../src/pages';

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

describe('proConfirmPage', () => {
	const now = Date.UTC(2026, 0, 15) / 1000;

	it('shows every plan, sale region and trial state before the confirmation button', async () => {
		for (const plan of ['monthly', 'yearly'] as const) {
			for (const region of ['domestic', 'overseas'] as const) {
				for (const trial of [true, false]) {
					const page = String(
						await proConfirmPage('ja', 'a@example.com', plan, region, { trial, now })
					);
					const amount = plan === 'yearly' ? '4,800 円' : '480 円';
					const interval = plan === 'yearly' ? '1 年' : '1 か月';

					expect(page).toContain(`Mawok Pro（${plan === 'yearly' ? '年額' : '月額'}）。`);
					expect(page).toContain(`解約するまで、${interval}ごとに自動で更新します。`);
					expect(page).toContain(amount);
					expect(page).toContain(`その後は ${interval}ごとに同じ額を支払います。`);
					expect(page).toContain(
						'解約はアカウントのページの「支払いを管理する」からいつでもできます。'
					);
					expect(page).toContain('次の更新日より前に解約すれば、次の期間の請求はありません。');

					// 日本の外の買い手には、日本時間の日付だと断る
					const day = region === 'overseas' ? '2026/1/29 (日本時間)' : '2026/1/29';
					if (trial) {
						expect(page).toContain(`${day} に最初の ${amount}を支払い、`);
						expect(page).toContain(
							`それまでの 14 日間は無料で、${day} より前に解約すれば、支払いは生じません。`
						);
						expect(page).toContain('試用の間は付かず、最初の支払いの後から付きます。');
					} else {
						expect(page).toContain(`申し込みのときに最初の ${amount}を支払い、`);
						expect(page).not.toContain('無料');
						expect(page).toContain('支払いが済むとすぐ、このアカウントで Pro を使えます。');
					}

					if (region === 'domestic') {
						expect(page).toContain(
							trial
								? '次の画面 (Stripe) でカードを登録します。'
								: '次の画面 (Stripe) でカードで払います。'
						);
					} else {
						expect(page).toContain('次の画面で払い方を選びます。');
						expect(page).toContain('カードの明細には「LINK.COM*」と出ます。');
					}
				}
			}
		}
	});

	it('joins the English sentences, and writes the date with the month name', async () => {
		const trial = String(
			await proConfirmPage('en', 'a@example.com', 'monthly', 'overseas', { trial: true, now })
		);
		expect(trial).toContain(
			'due on January 29, 2026 (Japan time), followed by payments of the same amount every month. The 14 days until then are free: cancel before January 29, 2026 (Japan time) and you will not be charged. Choose how to pay on the next page.'
		);
		const paid = String(
			await proConfirmPage('en', 'a@example.com', 'yearly', 'domestic', { trial: false, now })
		);
		expect(paid).toContain(
			'You pay the first 4,800 yen when you subscribe, then the same amount every year. Pay by card on the next page (Stripe).'
		);
		expect(paid).not.toContain('free');
	});
});
