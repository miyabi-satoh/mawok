/** 2つ以上のテストのファイルで使う補助。 */
import { env, exports } from 'cloudflare:workers';
import { expect, vi } from 'vitest';
import { randomHex } from '../src/util';

export const ORIGIN = 'http://account.test';

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

/** 「このデバイスを登録」を押し、Mawok の待ち受けへ戻された先のコードを返す。 */
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

/** 画面を通さずにアカウントを作る (残高などの単体テスト用)。 */
export async function newAccount() {
	const id = randomHex(16);
	await env.DB.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)')
		.bind(id, `${id}@example.com`)
		.run();
	return id;
}

/** 付与ごとの残り。購入の分が先、無料の分が後。 */
export async function grantsOf(account: string) {
	const { results } = await env.DB.prepare(
		`SELECT purchase_id IS NULL AS free, granted, remaining, revoked FROM grants
		 WHERE account_id = ? ORDER BY purchase_id IS NULL, created_at, rowid`
	)
		.bind(account)
		.all<{ free: number; granted: number; remaining: number; revoked: number }>();
	return results;
}

export function app(path: string, token: string | undefined, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	if (token) headers.set('authorization', `Bearer ${token}`);
	return request(path, { ...init, headers });
}

export function sendAi(
	token: string | undefined,
	body: unknown = { system: '丁寧に', user: 'こんにちは' }
) {
	return app('/v1/ai', token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

/** Gemini の返事を差し替える。`usage` のトークン数で原価が決まる。 */
export function geminiAnswers(
	usage: Record<string, number> = { total_input_tokens: 1000, total_output_tokens: 800 },
	status = 200
) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
		Response.json(
			status === 200
				? {
						status: 'completed',
						steps: [{ type: 'model_output', content: [{ type: 'text', text: '整えた文' }] }],
						usage
					}
				: { error: { code: status, message: 'nope' }, usage },
			{ status }
		)
	);
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

/** Checkout Session の知らせ。知らせの id は毎回変える (Stripe の送り直しを試すときは `id` に同じものを渡す)。 */
export function completed(
	sessionId: string,
	account: string,
	overrides: Record<string, unknown> = {},
	{ type = 'checkout.session.completed', id = `evt_${crypto.randomUUID()}` } = {}
) {
	return {
		id,
		type,
		data: {
			object: {
				id: sessionId,
				client_reference_id: account,
				payment_intent: `pi_${sessionId}`,
				payment_status: 'paid',
				metadata: { product: 'mawok-ai' },
				...overrides
			}
		}
	};
}

/**
 * 付ける前に取り直す Checkout Session を、Stripe と同じ形で返すよう差し替える。
 * 返すのは、問い合わせた id で `account` が買った、払われた Session (`overrides` で変える)。
 */
export function stripeSessions(account: string, overrides: Record<string, unknown> = {}) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
		const id = new URL(String(url)).pathname.split('/').pop()!;
		return Response.json({
			id,
			client_reference_id: account,
			payment_status: 'paid',
			currency: 'jpy',
			amount_total: 300,
			metadata: { product: 'mawok-ai', buyer_country: 'JP' },
			managed_payments: { enabled: false },
			line_items: {
				data: [{ quantity: 1, price: { id: 'price_credits', unit_amount: 300, currency: 'jpy' } }]
			},
			payment_intent: {
				id: `pi_${id}`,
				latest_charge: { payment_method_details: { card: { country: 'JP' } } }
			},
			...overrides
		});
	});
}

/** 買って残高を付ける。 */
export async function buy(account: string, sessionId: string) {
	stripeSessions(account);
	expect((await webhook(completed(sessionId, account))).status).toBe(200);
	vi.restoreAllMocks();
}
