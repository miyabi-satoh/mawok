/**
 * 全部の入口にかかる守りを、入口の表で回す。入口を足したら、表にも足す (足さないと最初のテストが落ちる)。
 * 守りの中身 (状態コードのほかの振る舞い) は、機能ごとのファイルで確かめる。
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { app as server } from '../../src/index';
import { accountId, app, linkApp, linkPath, newLink, postForm, request, signIn } from '../helpers';

type Guard =
	/** `Authorization: Bearer` のアプリ用のトークン。無い・知らない・外したものは 401。 */
	| 'token'
	/** サインインの Cookie。無ければサインインの画面を出す (200)。 */
	| 'session-page'
	/** サインインの Cookie。無ければサインインの画面を 401 で返し、何もしない。 */
	| 'session-401'
	/** よそのサイトからのフォームの送信を 403 で断る (hono/csrf の Origin の確かめ)。 */
	| 'csrf'
	/** 送り主 (IP) ごとの上限。 */
	| 'limit-ip'
	/** アカウントごとの上限。 */
	| 'limit-account'
	/** 外部のサインインの往復の印 (Cookie の state)。無ければ 400。 */
	| 'flow'
	/** Stripe の署名。無ければ 400。 */
	| 'stripe-signature';

/** 守りを確かめる要求に付けるもの。 */
type Send = { cookie?: string; token?: string; origin?: string; ip?: string };

type Entry = {
	route: string;
	guards: Guard[];
	/** 守りのほかは通る形で送る。 */
	send: (s: Send) => Promise<Response>;
};

const link = await newLink();
const form =
	(path: string, fields: Record<string, string> | (() => Record<string, string>)) => (s: Send) =>
		postForm(path, typeof fields === 'function' ? fields() : fields, s.cookie, {
			origin: s.origin,
			ip: s.ip
		});
const get = (path: string) => (s: Send) =>
	request(path, { cookie: s.cookie, ip: s.ip, redirect: 'manual' });

const ENTRIES: Entry[] = [
	{
		route: 'POST /v1/links/token',
		guards: ['limit-ip'],
		send: (s) =>
			request('/v1/links/token', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code: 'missing', code_verifier: 'x' }),
				ip: s.ip
			})
	},
	{ route: 'GET /v1/balance', guards: ['token'], send: (s) => app('/v1/balance', s.token) },
	// トークンを外すだけなので、トークンが無くても 204 を返す。
	{
		route: 'DELETE /v1/token',
		guards: [],
		send: (s) => app('/v1/token', s.token, { method: 'DELETE' })
	},
	{
		route: 'POST /v1/ai',
		guards: ['token'],
		send: (s) =>
			app('/v1/ai', s.token, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ user: 'x' })
			})
	},
	{
		route: 'GET /v1/sync',
		guards: ['token', 'limit-account'],
		send: (s) => app('/v1/sync', s.token)
	},
	{
		route: 'PUT /v1/sync',
		guards: ['token', 'limit-account'],
		send: (s) =>
			app('/v1/sync', s.token, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					key_id: 'a'.repeat(16),
					items: [{ collection: 'settings', id: 'x', base_seq: null, deleted: true }]
				})
			})
	},
	{
		route: 'POST /v1/sync/reset',
		guards: ['token', 'limit-account'],
		send: (s) =>
			app('/v1/sync/reset', s.token, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ key_id: 'a'.repeat(16) })
			})
	},
	{
		route: 'POST /v1/stripe/webhook',
		guards: ['stripe-signature'],
		send: () =>
			request('/v1/stripe/webhook', {
				method: 'POST',
				body: JSON.stringify({ id: 'evt_unsigned', type: 'customer.created', data: { object: {} } })
			})
	},
	{ route: 'GET /account', guards: ['session-page'], send: get('/account/') },
	{
		route: 'POST /account/apps/unlink',
		guards: ['csrf', 'session-401'],
		send: form('/account/apps/unlink', { id: 'x' })
	},
	{
		route: 'POST /account/login/email',
		guards: ['csrf', 'limit-ip'],
		// アドレスごとの上限に当たらないよう、アドレスは毎回変える。
		send: form('/account/login/email', () => ({
			email: `guard-${crypto.randomUUID()}@example.com`,
			next: '/account/'
		}))
	},
	// メールのリンクを開いた画面。サインインは次の POST でする。
	{ route: 'GET /account/login/email', guards: [], send: get('/account/login/email?token=x') },
	{
		route: 'POST /account/login/email/verify',
		guards: ['csrf'],
		send: form('/account/login/email/verify', { token: 'x' })
	},
	{ route: 'GET /account/login/google', guards: [], send: get('/account/login/google') },
	{
		route: 'GET /account/login/google/callback',
		guards: ['flow'],
		send: get('/account/login/google/callback?code=c&state=s')
	},
	{ route: 'GET /account/login/apple', guards: [], send: get('/account/login/apple') },
	// Apple のサイトから POST で戻るので、送り元を見ず、往復の印で守る。
	{
		route: 'POST /account/login/apple/callback',
		guards: ['flow'],
		send: form('/account/login/apple/callback', { code: 'c', state: 's' })
	},
	{
		route: 'POST /account/logout',
		guards: ['csrf'],
		send: form('/account/logout', { next: '/account/' })
	},
	{ route: 'GET /account/link', guards: ['session-page'], send: get(linkPath(link.fields)) },
	{
		route: 'POST /account/link',
		guards: ['csrf', 'session-401', 'limit-account'],
		send: form('/account/link', link.fields)
	},
	{
		route: 'POST /account/buy',
		guards: ['csrf', 'session-401'],
		send: form('/account/buy', { next: '/account/' })
	},
	{
		route: 'POST /account/billing',
		guards: ['csrf', 'session-401'],
		send: form('/account/billing', {})
	},
	{ route: 'GET /account/buy', guards: ['session-page'], send: get('/account/buy') },
	{
		route: 'GET /account/buy/done',
		guards: ['session-page'],
		send: get('/account/buy/done?next=%2Faccount%2F&session_id=cs_x')
	}
];

const guarded = (guard: Guard) => ENTRIES.filter((e) => e.guards.includes(guard));

/** サインインし、期限の切れたセッションの Cookie も作る。 */
async function sessions(email: string) {
	const { cookie } = await signIn(email);
	const expired = await signIn(`expired-${email}`);
	await env.DB.prepare(
		'UPDATE sessions SET expires_at = 0 WHERE account_id = (SELECT id FROM accounts WHERE email = ?)'
	)
		.bind(`expired-${email}`)
		.run();
	return { cookie, expired: expired.cookie };
}

describe('guards', () => {
	it('lists every entry in the table', () => {
		const routes = server.routes
			.filter((r) => r.method !== 'ALL')
			.map((r) => `${r.method} ${r.path.replace(/(.)\/$/, '$1')}`);
		expect([...new Set(routes)].sort()).toEqual(ENTRIES.map((e) => e.route).sort());
	});

	it('stops every entry when a pricing value is missing', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const broken = { ...env, USD_JPY: undefined } as unknown as Env;
		for (const { route } of ENTRIES) {
			const [method, path] = route.split(' ');
			expect((await server.request(path, { method }, broken)).status, route).toBe(500);
		}
	});

	it('refuses the app entries without a valid token', async () => {
		const { token } = await linkApp('guard-token@example.com');
		const revoked = (await linkApp('guard-revoked@example.com')).token;
		await app('/v1/token', revoked, { method: 'DELETE' });
		// トークンを確かめる前に Gemini へ送っていないことも見る。
		const fetch = vi.spyOn(globalThis, 'fetch');
		for (const entry of guarded('token')) {
			for (const [name, t] of [
				['no token', undefined],
				['unknown token', 'f'.repeat(64)],
				['revoked token', revoked]
			] as const) {
				const res = await entry.send({ token: t });
				expect(res.status, `${entry.route} (${name})`).toBe(401);
				expect(await res.json(), `${entry.route} (${name})`).toEqual({ error: 'unauthorized' });
			}
		}
		expect(fetch).not.toHaveBeenCalled();
		// 正しいトークンなら通る (表の要求の形が守りのほかで止まっていないことを見る)。
		vi.restoreAllMocks();
		expect((await app('/v1/balance', token)).status).toBe(200);
	});

	it('shows the sign-in page on the account pages without a session', async () => {
		const { expired } = await sessions('guard-page@example.com');
		for (const entry of guarded('session-page')) {
			for (const [name, cookie] of [
				['no session', undefined],
				['expired session', expired]
			] as const) {
				const res = await entry.send({ cookie });
				expect(res.status, `${entry.route} (${name})`).toBe(200);
				expect(await res.text(), `${entry.route} (${name})`).toContain(
					'action="/account/login/email"'
				);
			}
		}
	});

	it('refuses the account forms without a session, without doing anything', async () => {
		const { expired } = await sessions('guard-form@example.com');
		const fetch = vi.spyOn(globalThis, 'fetch');
		for (const entry of guarded('session-401')) {
			for (const [name, cookie] of [
				['no session', undefined],
				['expired session', expired]
			] as const) {
				const res = await entry.send({ cookie });
				expect(res.status, `${entry.route} (${name})`).toBe(401);
				expect(await res.text(), `${entry.route} (${name})`).toContain(
					'action="/account/login/email"'
				);
			}
		}
		// Stripe へ支払いの画面を頼んでいない。
		expect(fetch).not.toHaveBeenCalled();
	});

	it('rejects form posts from other sites, even when signed in', async () => {
		const email = 'guard-csrf@example.com';
		const { cookie } = await sessions(email);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		for (const entry of guarded('csrf')) {
			// Apple から戻り先へ送れるのは、戻り先だけ。
			for (const origin of ['https://evil.test', 'https://appleid.apple.com']) {
				const res = await entry.send({ cookie, origin });
				expect(res.status, `${entry.route} (${origin})`).toBe(403);
			}
		}
		expect(log).not.toHaveBeenCalled();
		// 何も書き換わっていない (サインアウトしていない)。
		expect(await (await request('/account/', { cookie })).text()).toContain(email);
	});

	it('refuses the sign-in callbacks without the round trip having started', async () => {
		for (const entry of guarded('flow')) {
			const res = await entry.send({ origin: 'https://appleid.apple.com' });
			expect(res.status, entry.route).toBe(400);
			expect(res.headers.getSetCookie().join(), entry.route).not.toContain('session=');
		}
	});

	it('rejects Stripe notices without a signature', async () => {
		for (const entry of guarded('stripe-signature')) {
			const res = await entry.send({});
			expect(res.status, entry.route).toBe(400);
			expect(await res.json(), entry.route).toEqual({ error: 'invalid_signature' });
		}
	});

	// 上限は時計に合わせた区切りごとに数えるので (wrangler.jsonc の ratelimits)、送る途中で区切りをまたぐと
	// 上限に届かないことがある。またいでも片側で上限 (いちばん大きい 60) を超えるよう、その2倍より多く送る。
	async function sendUntilLimited(send: () => Promise<Response>): Promise<number[]> {
		const statuses: number[] = [];
		for (let n = 0; n < 121 && !statuses.includes(429); n++) statuses.push((await send()).status);
		return statuses;
	}

	it('limits each sender', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		for (const [i, entry] of guarded('limit-ip').entries()) {
			const ip = `198.51.100.${i + 1}`;
			const statuses = await sendUntilLimited(() => entry.send({ ip }));
			expect(statuses, entry.route).toContain(429);
			expect(statuses[0], entry.route).not.toBe(429);
			// ほかの送り主は止めない。
			expect((await entry.send({ ip: `198.51.100.${i + 101}` })).status, entry.route).not.toBe(429);
		}
	});

	it('limits each account', async () => {
		for (const [index, entry] of guarded('limit-account').entries()) {
			const email = `guard-limit-${index}@example.com`;
			const first = await linkApp(email);
			const other = await linkApp(`guard-limit-other-${index}@example.com`);
			for (const accountEmail of [email, `guard-limit-other-${index}@example.com`]) {
				await env.DB.prepare(
					`INSERT INTO subscriptions (id, account_id, plan, paid_through, status, created_at)
					 VALUES (?, ?, 'monthly', 4102444800, 'trialing', 0)`
				)
					.bind(`guard_${accountEmail}`, await accountId(accountEmail))
					.run();
			}
			// 送り主 (IP) は毎回変わる。
			const statuses = await sendUntilLimited(() =>
				entry.send({ cookie: first.cookie, token: first.token })
			);
			expect(statuses, entry.route).toContain(429);
			expect(statuses[0], entry.route).not.toBe(429);
			expect(
				(await entry.send({ cookie: other.cookie, token: other.token })).status,
				entry.route
			).not.toBe(429);
		}
		// 同期の上限 (60) に当たるまで入口ごとに送るので、既定の 5 秒では遅い CI の機械で足りない。
	}, 60_000);
});
