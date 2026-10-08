/**
 * 残高 (→ docs/account-server.md「残高」)。単位は原価の 1/1000 円 (milli_yen)。
 * 付与は1行ずつ (`grants`) で持ち、引くときは購入の分を古い順に使い、無料の分は最後に使う。
 */
import { pricing } from './pricing';
import { now, randomHex } from './util';

/** 今の残高。`percent` は残りの割合 (切り上げ。使い切ったときだけ 0)。 */
export type Balance = { remaining: number; percent: number };

/**
 * 残りのある付与の、付けた量に対する残りの割合。金額や回数には直さない。
 * 買い足した直後に前の付与の残りがあると、両方を合わせた割合になる。
 */
export async function balance(env: Env, accountId: string): Promise<Balance> {
	const row = await env.DB.prepare(
		`SELECT coalesce(sum(remaining), 0) AS remaining, coalesce(sum(granted - revoked), 0) AS size
		 FROM grants WHERE account_id = ? AND remaining > 0`
	)
		.bind(accountId)
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
		`INSERT INTO grants (id, account_id, purchase_id, granted, remaining, created_at)
		 SELECT ?1, ?2, NULL, ?3, ?3, ?4
		 WHERE NOT EXISTS (SELECT 1 FROM grants WHERE account_id = ?2 AND purchase_id IS NULL)
		   AND (SELECT coalesce(sum(granted), 0) FROM grants
		        WHERE purchase_id IS NULL AND created_at >= ?5) + ?3 <= ?6`
	).bind(randomHex(16), accountId, freeGrant, t, monthStart(t), freeMonthlyCap);
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
		`SELECT id, remaining FROM grants WHERE account_id = ? AND remaining > 0
		 ORDER BY purchase_id IS NULL, created_at, rowid`
	)
		.bind(accountId)
		.all<{ id: string; remaining: number }>();
	const statements: D1PreparedStatement[] = [];
	let left = cost;
	for (const grant of results) {
		if (left <= 0) break;
		const amount = Math.min(left, grant.remaining);
		left -= amount;
		// 記録してから引く。どちらも、その時点の残りを超えない量にする。
		statements.push(
			env.DB.prepare(
				`INSERT INTO consumptions (id, purchase_id, milli_yen, created_at)
				 SELECT ?1, purchase_id, min(?2, remaining), ?3 FROM grants WHERE id = ?4 AND remaining > 0`
			).bind(randomHex(16), amount, t, grant.id),
			env.DB.prepare(
				'UPDATE grants SET remaining = remaining - min(?, remaining) WHERE id = ?'
			).bind(amount, grant.id)
		);
	}
	if (statements.length > 0) await env.DB.batch(statements);
}
