import { describe, expect, it } from 'vitest';
import { accountId, addProPurchase, addSubscription, app, FAR_FUTURE, linkApp } from '../helpers';

// Pro の状態の決まりは test/http/purchase.test.ts で確かめる。ここでは入口の答えの形を見る。
describe('account', () => {
	it('returns the account without Pro', async () => {
		const { token } = await linkApp('no-pro@example.com');
		expect(await (await app('/v1/account', token)).json()).toEqual({
			account_id: await accountId('no-pro@example.com'),
			email: 'no-pro@example.com',
			pro: { active: false, until: null, plan: null, trial: false }
		});
	});

	it('returns the active Pro plan through its earlier cancel_at time', async () => {
		const { token } = await linkApp('pro-account@example.com');
		const account = await accountId('pro-account@example.com');
		await addSubscription(account, {
			id: 'sub_account',
			plan: 'yearly',
			status: 'active',
			cancelAt: FAR_FUTURE - 800
		});
		// 払った請求書があるので、試用ではない。
		await addProPurchase(account, 'sub_account', { amount: 4800 });
		expect(await (await app('/v1/account', token)).json()).toEqual({
			account_id: account,
			email: 'pro-account@example.com',
			pro: { active: true, until: FAR_FUTURE - 800, plan: 'yearly', trial: false }
		});
	});
});
