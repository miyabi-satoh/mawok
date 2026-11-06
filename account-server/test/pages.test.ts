import { describe, expect, it } from 'vitest';
import { checkingPurchasePage, homePage, proConfirmPage } from '../src/pages';

describe('homePage', () => {
	it('says a canceled trial will not be charged in English', async () => {
		const page = String(
			await homePage('en', 'a@example.com', [], 'overseas', {
				pro: {
					active: true,
					until: 2_000_000_000,
					plan: 'monthly',
					trial: true,
					renews: false
				}
			})
		);
		expect(page).toContain('Your trial lasts until May 18, 2033 (Japan time)');
		expect(page).toContain('You will not be charged.');
	});
});

describe('checkingPurchasePage', () => {
	const checking = async (autoRetry: boolean) =>
		String(await checkingPurchasePage('ja', '/account/buy/done?tries=1', autoRetry));

	it('reloads while it waits, and offers a manual check once it gives up', async () => {
		const waiting = await checking(true);
		expect(waiting).toContain('<title>Mawok Pro - Mawok</title>');
		expect(waiting).toContain('<h1>Mawok Pro</h1>');
		expect(waiting).toContain('申し込みを確認しています');
		expect(waiting).toContain('http-equiv="refresh"');
		const gaveUp = await checking(false);
		expect(gaveUp).not.toContain('http-equiv="refresh"');
		expect(gaveUp).toContain('申し込みをまだ確認できていません');
		expect(gaveUp).toContain('もう一度確認');
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

					expect(page).toContain(`Mawok Pro (${plan === 'yearly' ? '年額' : '月額'})。`);
					expect(page).toContain(`解約するまで、${interval}ごとに自動で更新します。`);
					expect(page).toContain(amount);
					expect(page).toContain(`その後は ${interval}ごとに同じ額を支払います。`);
					expect(page).toContain(
						'解約はアカウントのページの「支払いを管理」からいつでもできます。'
					);
					expect(page).toContain('次の更新日より前に解約すれば、次の期間の請求はありません。');

					// 日本の外の買い手には、日本時間の日付だと断る
					const day = region === 'overseas' ? '2026/1/29 (日本時間)' : '2026/1/29';
					expect(page.split('(日本時間)').length - 1).toBe(trial && region === 'overseas' ? 1 : 0);
					if (trial) {
						expect(page).toContain(`${day} に最初の ${amount}を支払い、`);
						expect(page).toContain(
							`それまでの 14 日間は無料で、その日より前に解約すれば、支払いは生じません。`
						);
						expect(page).toContain('申し込みが済むとすぐ、このアカウントで Pro を使えます。');
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
			'due on January 29, 2026 (Japan time), followed by payments of the same amount every month. The 14 days until then are free: cancel before that date and you will not be charged. Choose how to pay on the next page.'
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
