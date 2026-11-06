/**
 * Pro の状態 (→ docs/account-server.md「Pro」)。サブスクの行 (`subscriptions`) と、払った請求書の台帳 (`purchases`) から読む。
 */
import { PRO_PRODUCT } from './stripe';
import { now } from './util';

/** Pro のプラン。Stripe の Price と予約の `price` 列を分ける。 */
export type ProPlan = 'monthly' | 'yearly';

export function isProPlan(value: unknown): value is ProPlan {
	return value === 'monthly' || value === 'yearly';
}

export type Pro = {
	active: boolean;
	until: number | null;
	plan: ProPlan | null;
	trial: boolean;
};

/** アカウントの画面だけに出す、次の期間へ更新されるかどうか。 */
export type AccountPro = Pro & { renews: boolean };

/** `subscriptions` の Pro を使える期限。 */
export const proUntilSql = 'min(coalesce(cancel_at, paid_through), paid_through)';

function proUntil(paidThrough: number, cancelAt: number | null) {
	return Math.min(cancelAt ?? paidThrough, paidThrough);
}

/** Pro の状態。払い終えた期間が今より後なら Pro のまま使える。 */
export async function proOf(env: Env, accountId: string, t = now()): Promise<AccountPro> {
	const row = await env.DB.prepare(
		`SELECT plan, paid_through, status, cancel_at_period_end, cancel_at,
		 EXISTS (SELECT 1 FROM purchases
		         WHERE stripe_subscription_id = subscriptions.id
		           AND product = '${PRO_PRODUCT}' AND revoked_at IS NULL) AS paid
		 FROM subscriptions
		 WHERE account_id = ? AND revoked_at IS NULL
		   AND ${proUntilSql} > ?
		 ORDER BY ${proUntilSql} DESC LIMIT 1`
	)
		.bind(accountId, t)
		.first<{
			plan: ProPlan;
			paid_through: number;
			status: string;
			cancel_at_period_end: number;
			cancel_at: number | null;
			paid: number;
		}>();
	return row
		? {
				active: true,
				until: proUntil(row.paid_through, row.cancel_at),
				plan: row.plan,
				trial: row.paid === 0,
				renews:
					row.status !== 'canceled' &&
					row.cancel_at_period_end !== 1 &&
					(row.cancel_at === null || row.cancel_at > row.paid_through)
			}
		: { active: false, until: null, plan: null, trial: false, renews: false };
}
