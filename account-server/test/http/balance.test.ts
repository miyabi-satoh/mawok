import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { pricing } from '../../src/pricing';
import { accountId, app, grantsOf, linkApp, request, signIn } from '../helpers';

const { freeGrant: FREE_GRANT } = pricing(env);

// 付ける・引く・割合の決まりは test/credits.test.ts で確かめる。ここでは入口につながっていることを見る。
describe('balance', () => {
	it('grants the free credit once, on first sign-in', async () => {
		const email = 'free@example.com';
		await signIn(email);
		await signIn(email);
		expect(await grantsOf(await accountId(email))).toEqual([
			{ free: 1, granted: FREE_GRANT, remaining: FREE_GRANT, revoked: 0 }
		]);
	});

	it('grants a held-back free credit when Mawok asks for the balance', async () => {
		const email = 'late-free@example.com';
		const { token } = await linkApp(email);
		const account = await accountId(email);
		await env.DB.prepare('DELETE FROM grants WHERE account_id = ?').bind(account).run();
		expect(await (await app('/v1/balance', token)).json()).toMatchObject({
			remaining_percent: 100
		});
		expect(await grantsOf(account)).toHaveLength(1);
	});

	it('shows what is left as a percentage on the account page', async () => {
		const { cookie } = await signIn('percent@example.com');
		expect(await (await request('/account/', { cookie })).text()).toContain(
			'AI アクションのクレジット: 残り 100%'
		);
	});

	it('returns the active Pro plan through its earlier cancel_at time', async () => {
		const { token } = await linkApp('pro-balance@example.com');
		const account = await accountId('pro-balance@example.com');
		await env.DB.prepare(
			`INSERT INTO subscriptions (id, account_id, plan, paid_through, status, cancel_at, created_at)
			 VALUES ('sub_balance', ?, 'yearly', 4102444800, 'active', 4102444000, 0)`
		)
			.bind(account)
			.run();
		// 払った請求書があるので、試用ではない。
		await env.DB.prepare(
			`INSERT INTO purchases (id, account_id, product, stripe_checkout_session_id, stripe_payment_intent_id,
			 amount, currency, managed_payments, domestic, stripe_subscription_id, created_at)
			 VALUES ('p_balance', ?, 'mawok-pro', 'invoice:in_balance', 'pi_balance', 4800, 'jpy', 0, 1, 'sub_balance', 0)`
		)
			.bind(account)
			.run();
		expect(await (await app('/v1/balance', token)).json()).toMatchObject({
			pro: { active: true, until: 4102444000, plan: 'yearly', trial: false }
		});
	});
});
