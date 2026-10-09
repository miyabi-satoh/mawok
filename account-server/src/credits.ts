/**
 * 残高 (→ docs/account-server.md「残高」)。単位は原価の 1/1000 円 (milli_yen)。
 * 付与は1行ずつ (`grants`) で持ち、引くときは購入の分を古い順に使い、無料の分は最後に使う。
 */
import { pricing } from './pricing';
import { now, randomHex } from './util';

/** 今の残高。`percent` は残りの割合 (切り上げ。使い切ったときだけ 0)。 */
export type Balance = { remaining: number; percent: number };
export type Pro = {
	active: boolean;
	until: number | null;
	plan: 'monthly' | 'yearly' | null;
	trial: boolean;
};

/** アカウントの画面だけに出す、次の期間へ更新されるかどうかと表示する期限。 */
export type AccountPro = Pro & { renews: boolean; displayUntil: number | null };

/**
 * 残りのある付与の、付けた量に対する残りの割合。金額や回数には直さない。
 * 買い足した直後に前の付与の残りがあると、両方を合わせた割合になる。
 */
export async function balance(env: Env, accountId: string): Promise<Balance> {
	const row = await env.DB.prepare(
		`SELECT coalesce(sum(remaining), 0) AS remaining, coalesce(sum(granted - revoked), 0) AS size
		 FROM grants WHERE account_id = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)`
	)
		.bind(accountId, now())
		.first<{ remaining: number; size: number }>();
	const remaining = row?.remaining ?? 0;
	const size = row?.size ?? 0;
	if (remaining <= 0) return { remaining: 0, percent: 0 };
	if (size <= 0) return { remaining, percent: 100 };
	return { remaining, percent: Math.min(100, Math.ceil((remaining * 100) / size)) };
}

/** その月の初め (UTC)。無料の分の月の上限を数える区切り。 */
function monthStart(t: number): number {
	const d = new Date(t * 1000);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

/**
 * 無料の分をまだ付けていないアカウントに付ける文。サインイン・残りの問い合わせ・中継のたびに流し、付けるのは一度だけ。
 * その月に付けた無料の分の合計に、この付与を足しても上限 (`FREE_MONTHLY_CAP_YEN`) を超えないときだけ付ける。
 * その月に付けた無料の分が全部使われても、原価は上限までに収まる。
 * 超えるときは付けず、翌月以降の次の問い合わせで付け直す。
 */
export function grantFreeStatement(env: Env, accountId: string, t = now()) {
	const { freeGrant, freeMonthlyCap } = pricing(env);
	return env.DB.prepare(
		`INSERT INTO grants (id, account_id, purchase_id, kind, granted, remaining, created_at)
		 SELECT ?1, ?2, NULL, 'free', ?3, ?3, ?4
		 WHERE NOT EXISTS (SELECT 1 FROM grants WHERE account_id = ?2 AND kind = 'free')
		   AND (SELECT coalesce(sum(granted), 0) FROM grants
		        WHERE kind = 'free' AND created_at >= ?5) + ?3 <= ?6`
	).bind(randomHex(16), accountId, freeGrant, t, monthStart(t), freeMonthlyCap);
}

/** Pro の状態。払い終えた期間が今より後なら Pro のまま使える。 */
export async function proOf(env: Env, accountId: string, t = now()): Promise<AccountPro> {
	const row = await env.DB.prepare(
		`SELECT plan, paid_through, status, cancel_at_period_end, cancel_at,
		 EXISTS (SELECT 1 FROM purchases
		         WHERE stripe_subscription_id = subscriptions.id
		           AND product = 'mawok-pro' AND revoked_at IS NULL) AS paid
		 FROM subscriptions
		 WHERE account_id = ? AND revoked_at IS NULL
		   AND min(coalesce(cancel_at, paid_through), paid_through) > ?
		 ORDER BY min(coalesce(cancel_at, paid_through), paid_through) DESC LIMIT 1`
	)
		.bind(accountId, t)
		.first<{
			plan: 'monthly' | 'yearly';
			paid_through: number;
			status: string;
			cancel_at_period_end: number;
			cancel_at: number | null;
			paid: number;
		}>();
	return row
		? {
				active: true,
				until: Math.min(row.cancel_at ?? row.paid_through, row.paid_through),
				plan: row.plan,
				trial: row.paid === 0,
				renews:
					row.status !== 'canceled' &&
					row.cancel_at_period_end !== 1 &&
					(row.cancel_at === null || row.cancel_at > row.paid_through),
				displayUntil: Math.min(row.cancel_at ?? row.paid_through, row.paid_through)
			}
		: { active: false, until: null, plan: null, trial: false, renews: false, displayUntil: null };
}

/** Asia/Tokyo の暦月の終わり。Pro の付与はその月だけ使える。 */
function tokyoMonthEnd(t: number): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'Asia/Tokyo',
		year: 'numeric',
		month: 'numeric'
	}).formatToParts(new Date(t * 1000));
	const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
	const year = Number(values.year);
	const month = Number(values.month);
	return (Date.UTC(year, month, 1) - 9 * 60 * 60 * 1000) / 1000;
}

/** 有効で支払い中の Pro に、その暦月の分を遅延で1回だけ付ける。 */
export function grantProStatement(env: Env, accountId: string, pro: Pro, t = now()) {
	const expiresAt = tokyoMonthEnd(t);
	const amount = pro.plan === 'yearly' ? pricing(env).proYearlyGrant : pricing(env).proMonthlyGrant;
	return env.DB.prepare(
		`INSERT INTO grants (id, account_id, purchase_id, kind, granted, remaining, expires_at, created_at)
		 SELECT ?1, ?2, NULL, 'pro', ?3, ?3, ?4, ?5
		 WHERE ?6 = 1 AND NOT EXISTS (
		   SELECT 1 FROM grants WHERE account_id = ?2 AND kind = 'pro' AND expires_at = ?4
		 )`
	).bind(randomHex(16), accountId, amount, expiresAt, t, pro.active && !pro.trial ? 1 : 0);
}

/**
 * 使った原価を引く。購入の分を古い順に、無料の分を最後に引き、引いた付与ごとに使った分を記録する。
 * 残りを超える分は引かない (最後の1回は、残りを超えても通す)。
 * 同じアカウントの中継は同時に1件だけなので、読んでから書く間にほかの中継が引くことはない。
 * 返金で取り消された付与と重なっても、書く文の側で残りを超えて引かない。
 */
export async function charge(env: Env, accountId: string, cost: number, t = now()) {
	if (cost <= 0) return;
	const { results } = await env.DB.prepare(
		`SELECT id, kind, remaining FROM grants WHERE account_id = ? AND remaining > 0
		 AND (expires_at IS NULL OR expires_at > ?)
		 ORDER BY CASE WHEN kind = 'pro' THEN 0 WHEN purchase_id IS NOT NULL THEN 1 ELSE 2 END, created_at, rowid`
	)
		.bind(accountId, t)
		.all<{ id: string; kind: 'pro' | 'purchase' | 'free'; remaining: number }>();
	const statements: D1PreparedStatement[] = [];
	let left = cost;
	for (const grant of results) {
		if (left <= 0) break;
		const amount = Math.min(left, grant.remaining);
		left -= amount;
		// 記録してから引く。どちらも、その時点の残りを超えない量にする。
		statements.push(
			env.DB.prepare(
				`INSERT INTO consumptions (id, purchase_id, grant_id, grant_kind, milli_yen, created_at)
					 SELECT ?1, purchase_id, id, kind, min(?2, remaining), ?3 FROM grants WHERE id = ?4 AND remaining > 0`
			).bind(randomHex(16), amount, t, grant.id),
			env.DB.prepare(
				'UPDATE grants SET remaining = remaining - min(?, remaining) WHERE id = ?'
			).bind(amount, grant.id)
		);
	}
	if (statements.length > 0) await env.DB.batch(statements);
}
