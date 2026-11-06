import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { DELETE_ACCOUNT_STATEMENTS } from '../../src/account-deletion';
import {
	accountId,
	addProPurchase,
	addSubscription,
	app,
	linkApp,
	request,
	webhook
} from '../helpers';

describe('deleting an account', () => {
	function deleteAccount(email: string) {
		return env.DB.batch(DELETE_ACCOUNT_STATEMENTS.map((s) => env.DB.prepare(s).bind(email)));
	}

	it('removes tokens, sessions and sync data, and keeps the purchase without the account', async () => {
		const email = 'leaving@example.com';
		const { cookie, token } = await linkApp(email);
		const account = await accountId(email);
		await addSubscription(account, {
			id: 'sub_leaving',
			customer: 'cus_leaving',
			status: 'active'
		});
		await addProPurchase(account, 'sub_leaving', { invoice: 'in_leaving' });
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO sync_accounts (account_id, key_id, seq, purged_seq, bytes)
					 VALUES (?, 'aaaaaaaaaaaaaaaa', 1, 0, 1)`
			).bind(account),
			env.DB.prepare(
				`INSERT INTO sync_items (account_id, collection, id, seq, deleted, data, updated_at)
					 VALUES (?, 'settings', 'one', 1, 0, x'01', 0)`
			).bind(account)
		]);
		await deleteAccount(email);
		expect(
			await env.DB.prepare('SELECT 1 FROM accounts WHERE id = ?').bind(account).first()
		).toBeNull();
		expect(
			await env.DB.prepare('SELECT 1 FROM sync_accounts WHERE account_id = ?').bind(account).first()
		).toBeNull();
		expect(
			await env.DB.prepare('SELECT 1 FROM sync_items WHERE account_id = ?').bind(account).first()
		).toBeNull();
		expect((await app('/v1/account', token)).status).toBe(401);
		expect(await (await request('/account/', { cookie })).text()).toContain(
			'action="/account/login/email"'
		);
		// 台帳には、取引の id・額・日時・MP の取引か・国内の取引かを残し、国は外す。
		const row = await env.DB.prepare(
			`SELECT id, account_id, amount, managed_payments, domestic, card_country, buyer_country FROM purchases
			 WHERE stripe_checkout_session_id = ?`
		)
			.bind('invoice:in_leaving')
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			account_id: null,
			amount: 480,
			managed_payments: 0,
			domestic: 1,
			card_country: null,
			buyer_country: null
		});
		expect(
			await env.DB.prepare('SELECT account_id, stripe_customer_id FROM subscriptions WHERE id = ?')
				.bind('sub_leaving')
				.first()
		).toEqual({ account_id: null, stripe_customer_id: null });
	});

	it('forgets purchases after the retention period', async () => {
		const email = 'old-buyer@example.com';
		await linkApp(email);
		const account = await accountId(email);
		await addSubscription(account, { id: 'sub_old', status: 'active' });
		await addProPurchase(account, 'sub_old', { invoice: 'in_old' });
		await deleteAccount(email);
		const eightYearsAgo = Math.floor(Date.now() / 1000) - 8 * 366 * 24 * 60 * 60;
		const exists = () =>
			env.DB.prepare('SELECT id FROM purchases WHERE stripe_checkout_session_id = ?')
				.bind('invoice:in_old')
				.first<{ id: string }>();
		const purchase = (await exists())!.id;
		// 買ったのが昔でも、消してから7年は残す。
		await env.DB.prepare('UPDATE purchases SET created_at = ? WHERE id = ?')
			.bind(eightYearsAgo, purchase)
			.run();
		await webhook({ id: 'evt_other1', type: 'customer.created', data: { object: {} } });
		expect(await exists()).not.toBeNull();
		await env.DB.prepare('UPDATE purchases SET detached_at = ? WHERE id = ?')
			.bind(eightYearsAgo, purchase)
			.run();
		await webhook({ id: 'evt_other2', type: 'customer.created', data: { object: {} } });
		expect(await exists()).toBeNull();
	});
});
