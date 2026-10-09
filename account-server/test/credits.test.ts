import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { balance, charge, grantFreeStatement, grantProStatement } from '../src/credits';
import { pricing } from '../src/pricing';
import { randomHex } from '../src/util';
import { grantsOf, newAccount } from './helpers';

const { purchaseGrant: PURCHASE_GRANT, freeGrant: FREE_GRANT } = pricing(env);

/** 付与を1行足す。`purchase` を渡すと、購入の分にする (台帳の行も作る)。 */
async function addGrant(
	account: string,
	{
		granted,
		remaining = granted,
		revoked = 0,
		createdAt = 0,
		purchase,
		kind = purchase ? 'purchase' : 'free',
		expiresAt
	}: {
		granted: number;
		remaining?: number;
		revoked?: number;
		createdAt?: number;
		purchase?: string;
		kind?: 'purchase' | 'free' | 'pro';
		expiresAt?: number;
	}
) {
	if (purchase) {
		await env.DB.prepare(
			`INSERT INTO purchases (id, account_id, product, stripe_checkout_session_id, stripe_payment_intent_id,
			   amount, currency, managed_payments, domestic, created_at)
			 VALUES (?1, ?2, 'mawok-ai', ?1, ?1, 300, 'jpy', 0, 1, 0)`
		)
			.bind(purchase, account)
			.run();
	}
	await env.DB.prepare(
		`INSERT INTO grants (id, account_id, purchase_id, kind, granted, remaining, revoked, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			randomHex(16),
			account,
			purchase ?? null,
			kind,
			granted,
			remaining,
			revoked,
			expiresAt ?? null,
			createdAt
		)
		.run();
}

describe('balance', () => {
	it('is the share of what is left, rounded up, and 0 only when used up', async () => {
		const account = await newAccount();
		expect(await balance(env, account)).toEqual({ remaining: 0, percent: 0 });
		await addGrant(account, { granted: FREE_GRANT, remaining: 1 });
		expect(await balance(env, account)).toEqual({ remaining: 1, percent: 1 });
	});

	it('adds up the grants that still have some left, without what was taken back', async () => {
		const account = await newAccount();
		await addGrant(account, { granted: PURCHASE_GRANT, remaining: 0 });
		await addGrant(account, { granted: PURCHASE_GRANT, remaining: 40_000, purchase: randomHex(8) });
		await addGrant(account, { granted: FREE_GRANT });
		// 使い切った付与は数えず、(残り + 無料の分) / (付けた量 + 無料の分) を切り上げる。
		expect(await balance(env, account)).toEqual({
			remaining: 40_000 + FREE_GRANT,
			percent: Math.ceil(((40_000 + FREE_GRANT) * 100) / (PURCHASE_GRANT + FREE_GRANT))
		});

		const refunded = await newAccount();
		await addGrant(refunded, {
			granted: PURCHASE_GRANT,
			remaining: 40_000,
			revoked: PURCHASE_GRANT - 40_000
		});
		expect(await balance(env, refunded)).toEqual({ remaining: 40_000, percent: 100 });
	});
});

describe('charge', () => {
	async function consumptionsOf(purchases: string[]) {
		const { results } = await env.DB.prepare(
			`SELECT purchase_id AS purchase, milli_yen FROM consumptions
			 WHERE purchase_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`
		)
			.bind(JSON.stringify(purchases))
			.all();
		return results;
	}

	it('uses purchased credit first, oldest first, and free credit last, recording each use', async () => {
		const account = await newAccount();
		const [older, newer] = [randomHex(8), randomHex(8)];
		await addGrant(account, { granted: FREE_GRANT, createdAt: 1 });
		await addGrant(account, { granted: PURCHASE_GRANT, createdAt: 3, purchase: newer });
		await addGrant(account, { granted: PURCHASE_GRANT, createdAt: 2, purchase: older });
		await charge(env, account, PURCHASE_GRANT + 100, 10);
		expect(await grantsOf(account)).toEqual([
			{ free: 0, granted: PURCHASE_GRANT, remaining: 0, revoked: 0 },
			{ free: 0, granted: PURCHASE_GRANT, remaining: PURCHASE_GRANT - 100, revoked: 0 },
			{ free: 1, granted: FREE_GRANT, remaining: FREE_GRANT, revoked: 0 }
		]);
		expect(await consumptionsOf([older, newer])).toEqual([
			{ purchase: older, milli_yen: PURCHASE_GRANT },
			{ purchase: newer, milli_yen: 100 }
		]);
	});

	it('takes the free credit once the purchased credit is used up', async () => {
		const account = await newAccount();
		await addGrant(account, { granted: FREE_GRANT });
		await addGrant(account, { granted: PURCHASE_GRANT, remaining: 0, purchase: randomHex(8) });
		await charge(env, account, 300);
		expect((await grantsOf(account))[1]).toMatchObject({ free: 1, remaining: FREE_GRANT - 300 });
	});

	it('lets the last use go over what is left, taking only what is left', async () => {
		const account = await newAccount();
		await addGrant(account, { granted: FREE_GRANT, remaining: 100 });
		await charge(env, account, 5_000);
		expect(await grantsOf(account)).toMatchObject([{ remaining: 0 }]);
		// 残りが無ければ何もしない。
		await charge(env, account, 5_000);
		await charge(env, account, 0);
		expect(await grantsOf(account)).toMatchObject([{ remaining: 0 }]);
	});

	it('uses this month’s Pro credit before purchases and ignores an expired grant', async () => {
		const account = await newAccount();
		await addGrant(account, { granted: 100, kind: 'pro', expiresAt: 4_102_444_800 });
		await addGrant(account, { granted: 100, kind: 'pro', expiresAt: 1 });
		await addGrant(account, { granted: PURCHASE_GRANT, purchase: randomHex(8) });
		await charge(env, account, 150, 10);
		const rows = await env.DB.prepare(
			`SELECT grant_kind AS kind, milli_yen FROM consumptions
			 WHERE grant_id IN (SELECT id FROM grants WHERE account_id = ?) ORDER BY rowid`
		)
			.bind(account)
			.all();
		expect(rows.results).toEqual([
			{ kind: 'pro', milli_yen: 100 },
			{ kind: 'purchase', milli_yen: 50 }
		]);
	});
});

describe('grantFreeStatement', () => {
	// 月の初めより後に付けた無料の分を数えるので、ほかのテストが今付けた分と重ならない先の月で試す。
	const MID_JANUARY = Date.UTC(2100, 0, 15) / 1000;
	const MID_FEBRUARY = Date.UTC(2100, 1, 15) / 1000;
	// 上限は、2つ分は付けられて、3つ目は付けられない額。
	const capped = { ...env, FREE_MONTHLY_CAP_YEN: String((FREE_GRANT * 2.5) / 1000) } as Env;

	it('grants once per account', async () => {
		const account = await newAccount();
		await grantFreeStatement(env, account).run();
		await grantFreeStatement(env, account).run();
		expect(await grantsOf(account)).toEqual([
			{ free: 1, granted: FREE_GRANT, remaining: FREE_GRANT, revoked: 0 }
		]);
	});

	it('holds back once the month has given out up to the cap, counting what was granted, and grants in a later month', async () => {
		const [first, second, third] = [await newAccount(), await newAccount(), await newAccount()];
		await grantFreeStatement(capped, first, MID_JANUARY).run();
		await grantFreeStatement(capped, second, MID_JANUARY).run();
		await grantFreeStatement(capped, third, MID_JANUARY).run();
		expect(await grantsOf(third)).toEqual([]);
		// 使われずに残っているかではなく、その月に付けた量で数える。
		await env.DB.prepare('UPDATE grants SET remaining = 0 WHERE account_id IN (?, ?)')
			.bind(first, second)
			.run();
		await grantFreeStatement(capped, third, MID_JANUARY).run();
		expect(await grantsOf(third)).toEqual([]);
		await grantFreeStatement(capped, third, MID_FEBRUARY).run();
		expect(await grantsOf(third)).toHaveLength(1);
	});
});

describe('grantProStatement', () => {
	it('grants once in a Tokyo calendar month, only while paid and active', async () => {
		const account = await newAccount();
		const at = Date.UTC(2100, 0, 15) / 1000;
		const pro = { active: true, until: at + 1000, plan: 'monthly' as const, trial: false };
		await grantProStatement(env, account, pro, at).run();
		await grantProStatement(env, account, pro, at).run();
		await grantProStatement(env, account, { ...pro, trial: true }, at + 1).run();
		const row = await env.DB.prepare(
			"SELECT granted, expires_at FROM grants WHERE account_id = ? AND kind = 'pro'"
		)
			.bind(account)
			.first<{ granted: number; expires_at: number }>();
		expect(row?.granted).toBe(pricing(env).proMonthlyGrant);
		expect(row?.expires_at).toBe(Date.UTC(2100, 1, 1) / 1000 - 9 * 60 * 60);
	});
});
