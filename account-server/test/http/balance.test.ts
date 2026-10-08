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
});
