import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { DELETE_ACCOUNT_STATEMENTS } from '../../src/account-deletion';
import {
	accountId,
	app,
	buy,
	geminiAnswers,
	grantsOf,
	linkApp,
	request,
	sendAi,
	webhook
} from '../helpers';

describe('deleting an account', () => {
	function deleteAccount(email: string) {
		return env.DB.batch(DELETE_ACCOUNT_STATEMENTS.map((s) => env.DB.prepare(s).bind(email)));
	}

	it('removes credit, tokens and sessions, and keeps the purchase and its uses without the account', async () => {
		const email = 'leaving@example.com';
		const { cookie, token } = await linkApp(email);
		const account = await accountId(email);
		await buy(account, 'cs_leaving');
		await env.DB.prepare(
			`INSERT INTO subscriptions (id, account_id, plan, stripe_customer_id, paid_through, status, created_at)
			 VALUES ('sub_leaving', ?, 'monthly', 'cus_leaving', 4_102_444_800, 'active', 0)`
		)
			.bind(account)
			.run();
		geminiAnswers();
		await sendAi(token);
		vi.restoreAllMocks();
		await deleteAccount(email);
		expect(
			await env.DB.prepare('SELECT 1 FROM accounts WHERE id = ?').bind(account).first()
		).toBeNull();
		expect(await grantsOf(account)).toEqual([]);
		expect((await app('/v1/balance', token)).status).toBe(401);
		expect(await (await request('/account/', { cookie })).text()).toContain(
			'action="/account/login/email"'
		);
		// 台帳には、取引の id・額・日時・MP の取引か・国内の取引かを残し、国は外す。
		const row = await env.DB.prepare(
			`SELECT id, account_id, amount, managed_payments, domestic, card_country, buyer_country FROM purchases
			 WHERE stripe_checkout_session_id = ?`
		)
			.bind('cs_leaving')
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			account_id: null,
			amount: 300,
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
		// 消費税の申告のため、使った分の記録も残す。
		expect(
			await env.DB.prepare('SELECT 1 FROM consumptions WHERE purchase_id = ?').bind(row!.id).first()
		).not.toBeNull();
	});

	it('forgets purchases and uses after the retention period', async () => {
		const email = 'old-buyer@example.com';
		const { token } = await linkApp(email);
		const account = await accountId(email);
		await buy(account, 'cs_old');
		geminiAnswers();
		await sendAi(token);
		vi.restoreAllMocks();
		await deleteAccount(email);
		const eightYearsAgo = Math.floor(Date.now() / 1000) - 8 * 366 * 24 * 60 * 60;
		const exists = () =>
			env.DB.prepare('SELECT id FROM purchases WHERE stripe_checkout_session_id = ?')
				.bind('cs_old')
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
		await env.DB.prepare('UPDATE consumptions SET created_at = ? WHERE purchase_id IS NULL')
			.bind(eightYearsAgo)
			.run();
		await webhook({ id: 'evt_other2', type: 'customer.created', data: { object: {} } });
		expect(await exists()).toBeNull();
		expect(
			await env.DB.prepare('SELECT 1 FROM consumptions WHERE purchase_id = ?')
				.bind(purchase)
				.first()
		).toBeNull();
	});
});
