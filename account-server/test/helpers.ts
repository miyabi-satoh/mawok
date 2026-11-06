/** 2つ以上のテストのファイルで使う補助。 */
import { env, exports } from 'cloudflare:workers';
import { expect, vi } from 'vitest';
import { randomHex } from '../src/util';

export const ORIGIN = 'http://account.test';
/** 期限が切れない行を置くための、遠い先の時刻 (2100-01-01)。 */
export const FAR_FUTURE = 4_102_444_800;

/** Pro のサブスクの行を置き、id を返す。指定が無ければ、遠い先まで払い終えた試用中の月額。 */
export async function addSubscription(
	accountId: string,
	fields: {
		id?: string;
		plan?: 'monthly' | 'yearly';
		customer?: string;
		paidThrough?: number;
		status?: string;
		cancelAtPeriodEnd?: boolean;
		cancelAt?: number;
	} = {}
) {
	const id = fields.id ?? randomHex(16);
	await env.DB.prepare(
		`INSERT INTO subscriptions
		 (id, account_id, plan, stripe_customer_id, paid_through, status, cancel_at_period_end, cancel_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
	)
		.bind(
			id,
			accountId,
			fields.plan ?? 'monthly',
			fields.customer ?? null,
			fields.paidThrough ?? FAR_FUTURE,
			fields.status ?? 'trialing',
			fields.cancelAtPeriodEnd ? 1 : 0,
			fields.cancelAt ?? null
		)
		.run();
	return id;
}

/** サブスクの払った請求書を、台帳に置く。台帳にあれば、そのサブスクは試用でない (→ src/pro.ts)。 */
export async function addProPurchase(
	accountId: string,
	subscriptionId: string,
	{ amount = 480, invoice = `in_${subscriptionId}` }: { amount?: number; invoice?: string } = {}
) {
	await env.DB.prepare(
		`INSERT INTO purchases (id, account_id, product, stripe_checkout_session_id, stripe_payment_intent_id,
		 amount, currency, managed_payments, card_country, buyer_country, domestic, stripe_subscription_id, created_at)
		 VALUES (?, ?, 'mawok-pro', ?, ?, ?, 'jpy', 0, 'JP', 'JP', 1, ?, 0)`
	)
		.bind(randomHex(16), accountId, `invoice:${invoice}`, `pi_${invoice}`, amount, subscriptionId)
		.run();
}

/**
 * 送り主 (IP) は、指定が無ければ毎回変える。IP ごとの上限を確かめるテスト以外で当たらないように。
 * 言語は、指定が無ければ日本語のブラウザにする。
 */
export function request(
	path: string,
	init: RequestInit & { cookie?: string; ip?: string; country?: string } = {}
) {
	const headers = new Headers(init.headers);
	if (!headers.has('accept-language')) headers.set('accept-language', 'ja');
	if (init.cookie) headers.set('cookie', init.cookie);
	headers.set('cf-connecting-ip', init.ip ?? crypto.randomUUID());
	// アクセス元の国 (Cloudflare が付ける)。指定が無ければ日本にする。
	const cf = { country: init.country ?? 'JP' };
	return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers, cf }));
}

/** 画面のフォームから送ったのと同じ形 (Origin 付き) で送る。 */
export function postForm(
	path: string,
	fields: Record<string, string>,
	cookie?: string,
	{ origin = ORIGIN, ip, country }: { origin?: string; ip?: string; country?: string } = {}
) {
	return request(path, {
		method: 'POST',
		headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields).toString(),
		cookie,
		ip,
		country,
		redirect: 'manual'
	});
}

/** Mawok が作るのと同じ形の申し込みの値。検証用の値は Mawok だけが持つ。 */
export async function newLink(name = 'mac-mini') {
	const verifier =
		crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	const challenge = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
		''
	);
	const state = crypto.randomUUID().replaceAll('-', '');
	return { verifier, fields: { port: '53682', state, challenge, name } };
}

export function linkPath(fields: Record<string, string>) {
	return `/account/link?${new URLSearchParams(fields)}`;
}

/** 「このデバイスを登録する」を押し、Mawok の待ち受けへ戻された先のコードを返す。 */
export async function approve(fields: Record<string, string>, cookie: string) {
	const res = await postForm('/account/link', fields, cookie);
	expect(res.status).toBe(303);
	const back = new URL(res.headers.get('location')!);
	expect(back.origin).toBe(`http://127.0.0.1:${fields.port}`);
	expect(back.pathname).toBe('/callback');
	expect(back.searchParams.get('state')).toBe(fields.state);
	return back.searchParams.get('code')!;
}

export function exchange(code: string, verifier: string, ip?: string) {
	return request('/v1/links/token', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ code, code_verifier: verifier }),
		ip
	});
}

/** メールのリンクでサインインし、セッションの Cookie を返す。送ったメールはログから拾う。 */
export async function signIn(email: string, next = '/account/') {
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	const sent = await postForm('/account/login/email', { email, next });
	expect(sent.status).toBe(200);
	const mail = String(log.mock.calls.at(-1)?.[0]);
	log.mockRestore();
	const token = new URL(mail.match(/http\S+/)![0]).searchParams.get('token')!;
	const verified = await postForm('/account/login/email/verify', { token });
	expect(verified.status).toBe(303);
	return {
		cookie: verified.headers.get('set-cookie')!.split(';')[0],
		location: verified.headers.get('location'),
		token
	};
}

/** サインインして Mawok を結び、アプリ用のトークンを返す。 */
export async function linkApp(email: string) {
	const { cookie } = await signIn(email);
	const { verifier, fields } = await newLink();
	const code = await approve(fields, cookie);
	const answer = await (await exchange(code, verifier)).json<{ token: string }>();
	return { cookie, token: answer.token };
}

/** 外部のサインインから戻った応答の、セッションの Cookie。 */
export function sessionCookie(res: Response) {
	return res.headers
		.getSetCookie()
		.find((c) => c.startsWith('session='))
		?.split(';')[0];
}

export async function accountId(email: string) {
	const row = await env.DB.prepare('SELECT id FROM accounts WHERE email = ?')
		.bind(email)
		.first<{ id: string }>();
	return row!.id;
}

/** 画面を通さずにアカウントを作る (単体テスト用)。 */
export async function newAccount() {
	const id = randomHex(16);
	await env.DB.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)')
		.bind(id, `${id}@example.com`)
		.run();
	return id;
}

export function app(path: string, token: string | undefined, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	if (token) headers.set('authorization', `Bearer ${token}`);
	return request(path, { ...init, headers });
}

/** Stripe と同じ形の `Stripe-Signature` を作る。 */
export async function stripeSignature(body: string, secret: string, at: number) {
	const t = Math.floor(at);
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = new Uint8Array(
		await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`))
	);
	return `t=${t},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Stripe と同じ形の署名を付けて webhook を送る。 */
export async function webhook(
	event: object,
	{ secret = 'whsec_test', at = Date.now() / 1000 } = {}
) {
	const body = JSON.stringify(event);
	return request('/v1/stripe/webhook', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'stripe-signature': await stripeSignature(body, secret, at)
		},
		body
	});
}
