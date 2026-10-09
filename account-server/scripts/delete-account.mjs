// 窓口のアカウントを消す (→ src/account-deletion.ts)。削除の請求を問い合わせで受けたときに、運営者が流す。
// 購入の台帳とサブスクの行は、結び付きだけを外して残る。先に Stripe でサブスクをその場で解約する。
//
// 使い方: STRIPE_SECRET_KEY=<key> node scripts/delete-account.mjs <メールアドレス> [--env staging]
import { spawnSync } from 'node:child_process';
import { DELETE_ACCOUNT_STATEMENTS, OPEN_CHECKOUT_SESSIONS } from '../src/account-deletion.ts';

const [rawEmail, ...rest] = process.argv.slice(2);
const email = (rawEmail ?? '').trim().toLowerCase();
const env = rest[0] === '--env' && rest[1] ? ['--env', rest[1]] : [];
const stripeKey = process.env.STRIPE_SECRET_KEY;
// SQL に書き込むので、アドレスの形でないものは通さない (引用符を含む値で文を壊さないように)。
if (!/^[^\s'"@;]+@[^\s'"@;]+$/.test(email) || (rest.length > 0 && env.length === 0) || !stripeKey) {
	console.error(
		'usage: STRIPE_SECRET_KEY=<key> node scripts/delete-account.mjs <email> [--env staging]'
	);
	process.exit(1);
}

function d1(sql, json = false) {
	const result = spawnSync(
		'pnpm',
		[
			'exec',
			'wrangler',
			'd1',
			'execute',
			'DB',
			'--remote',
			...env,
			...(json ? ['--json'] : []),
			'--command',
			sql
		],
		{ stdio: json ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' }
	);
	if (result.status !== 0) process.exit(result.status ?? 1);
	return json ? JSON.parse(result.stdout) : undefined;
}
const rows = d1(
	`SELECT id FROM subscriptions WHERE account_id = (SELECT id FROM accounts WHERE email = '${email}') AND id LIKE 'sub_%'`,
	true
);
for (const { id } of rows[0].results) {
	const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, {
		method: 'DELETE',
		headers: { authorization: `Bearer ${stripeKey}` }
	});
	if (!res.ok && res.status !== 404 && res.status !== 400)
		throw new Error(`Stripe ${res.status}: ${await res.text()}`);
	console.log(`canceled ${id}`);
}
const checkouts = d1(OPEN_CHECKOUT_SESSIONS.replaceAll('?1', `'${email}'`), true);
for (const { session_id: sessionId } of checkouts[0].results) {
	const res = await fetch(
		`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
		{ method: 'POST', headers: { authorization: `Bearer ${stripeKey}` } }
	);
	// 既に払われた・閉じた Session は Stripe が 400 にする。支払い済みなら webhook 側でサブスクを解約する。
	if (!res.ok && res.status !== 400 && res.status !== 404)
		throw new Error(`Stripe ${res.status}: ${await res.text()}`);
	console.log(`expired ${sessionId}`);
}
d1(DELETE_ACCOUNT_STATEMENTS.map((s) => `${s.replaceAll('?1', `'${email}'`)};`).join('\n'));
