import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { accountId, grantsOf, ORIGIN, postForm, request, sessionCookie, signIn } from '../helpers';

describe('Apple sign-in', () => {
	const APPLE = 'https://appleid.apple.com';

	/** Apple の画面へ送り、戻ってきたときに要る Cookie と state・nonce を返す。 */
	async function startApple(next = '/account/', lang = 'ja') {
		const res = await request(`/account/login/apple?next=${encodeURIComponent(next)}`, {
			headers: { 'accept-language': lang },
			redirect: 'manual'
		});
		expect(res.status).toBe(303);
		const to = new URL(res.headers.get('location')!);
		expect(`${to.origin}${to.pathname}`).toBe(`${APPLE}/auth/authorize`);
		expect(to.searchParams.get('client_id')).toBe('com.example.web');
		expect(to.searchParams.get('response_mode')).toBe('form_post');
		expect(to.searchParams.get('scope')).toBe('email');
		expect(to.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/account/login/apple/callback`);
		return {
			cookie: res.headers.get('set-cookie')!.split(';')[0],
			state: to.searchParams.get('state')!,
			nonce: to.searchParams.get('nonce')!
		};
	}

	/** Apple のサイトから戻り先へ POST する。トークンのエンドポイントは、claims の ID トークンを返す。 */
	async function back(
		flow: { cookie: string; state: string; nonce: string },
		claims: Record<string, unknown> = {},
		fields: Record<string, string> = { code: 'c', state: flow.state },
		origin = APPLE
	) {
		const body = btoa(
			JSON.stringify({
				iss: APPLE,
				aud: 'com.example.web',
				exp: Math.floor(Date.now() / 1000) + 300,
				nonce: flow.nonce,
				sub: 'apple-sub-1',
				email: 'a@example.com',
				email_verified: 'true',
				...claims
			})
		).replaceAll('=', '');
		const token = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => Response.json({ id_token: `e30.${body}.sig` }));
		const res = await postForm('/account/login/apple/callback', fields, flow.cookie, { origin });
		return { res, token };
	}

	function decodePart(part: string) {
		return atob(part.replaceAll('-', '+').replaceAll('_', '/'));
	}

	it('signs in with a client secret signed by the Apple key and comes back to the same account', async () => {
		const { res, token } = await back(await startApple('/account/link?code=ABCDEF'), {
			sub: 'a-new',
			email: 'A-New@Example.com'
		});
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('/account/link?code=ABCDEF');
		const home = await (await request('/account/', { cookie: sessionCookie(res) })).text();
		expect(home).toContain('a-new@example.com');
		expect(await grantsOf(await accountId('a-new@example.com'))).toHaveLength(1);

		const [url, init] = token.mock.calls[0];
		expect(url).toBe(`${APPLE}/auth/token`);
		const sent = new URLSearchParams(String(init!.body));
		expect(sent.get('client_id')).toBe('com.example.web');
		expect(sent.get('grant_type')).toBe('authorization_code');
		expect(sent.get('redirect_uri')).toBe(`${ORIGIN}/account/login/apple/callback`);
		const [header, payload, signature] = sent.get('client_secret')!.split('.');
		expect(JSON.parse(decodePart(header))).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
		const claims = JSON.parse(decodePart(payload));
		expect(claims).toMatchObject({ iss: 'TEAM123456', aud: APPLE, sub: 'com.example.web' });
		expect(claims.exp - claims.iat).toBe(300);
		const key = await crypto.subtle.importKey(
			'jwk',
			JSON.parse(env.TEST_APPLE_PUBLIC_KEY),
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify']
		);
		expect(
			await crypto.subtle.verify(
				{ name: 'ECDSA', hash: 'SHA-256' },
				key,
				Uint8Array.from(decodePart(signature), (ch) => ch.charCodeAt(0)),
				new TextEncoder().encode(`${header}.${payload}`)
			)
		).toBe(true);

		vi.restoreAllMocks();
		// Apple でメールアドレスを変えても、識別子で同じアカウントに入る。
		const again = await back(await startApple(), { sub: 'a-new', email: 'renamed-a@example.com' });
		const page = await (await request('/account/', { cookie: sessionCookie(again.res) })).text();
		expect(page).toContain('a-new@example.com');
	});

	it('joins the account of the same address, but keeps a relay address as its own account', async () => {
		await signIn('email-then-apple@example.com');
		const joined = await back(await startApple(), {
			sub: 'a-both',
			email: 'email-then-apple@example.com',
			email_verified: true
		});
		expect(sessionCookie(joined.res)).toBeDefined();
		const { n } = (await env.DB.prepare(
			"SELECT count(*) AS n FROM accounts WHERE email = 'email-then-apple@example.com'"
		).first<{ n: number }>())!;
		expect(n).toBe(1);

		vi.restoreAllMocks();
		const relay = await back(await startApple(), {
			sub: 'a-relay',
			email: 'xyz123@privaterelay.appleid.com'
		});
		const home = await (await request('/account/', { cookie: sessionCookie(relay.res) })).text();
		expect(home).toContain('xyz123@privaterelay.appleid.com');
	});

	it('does not link a second Apple account to the same account', async () => {
		await back(await startApple(), { sub: 'a-first', email: 'twice-a@example.com' });
		vi.restoreAllMocks();
		const { res } = await back(await startApple(), {
			sub: 'a-second',
			email: 'twice-a@example.com'
		});
		expect(res.status).toBe(409);
		expect(sessionCookie(res)).toBeUndefined();
	});

	it('goes back to the sign-in page quietly when cancelled on Apple', async () => {
		const flow = await startApple('/account/link?code=ABCDEF');
		const { res, token } = await back(
			flow,
			{},
			{ error: 'user_cancelled_authorize', state: flow.state }
		);
		expect(res.status).toBe(200);
		expect(token).not.toHaveBeenCalled();
		const page = await res.text();
		expect(page).not.toContain('role="alert"');
		expect(page).toContain('value="/account/link?code=ABCDEF"');
	});

	// ID トークンの確かめは finishAppleSignIn (Context を取る) の中にあり、切り出していないので、ここで場合ごとに確かめる。
	it('rejects a wrong state, nonce, audience, issuer, an expired token or an unverified email', async () => {
		for (const [claims, state] of [
			[{}, 'wrong-state'],
			[{ nonce: 'other' }, undefined],
			[{ aud: 'someone-else' }, undefined],
			[{ iss: 'https://evil.test' }, undefined],
			[{ exp: Math.floor(Date.now() / 1000) - 1 }, undefined],
			[{ email_verified: 'false' }, undefined],
			[{ email: undefined }, undefined]
		] as const) {
			vi.restoreAllMocks();
			const flow = await startApple();
			const { res } = await back(
				flow,
				{ sub: 'a-bad', email: 'bad-a@example.com', ...claims },
				{ code: 'c', state: state ?? flow.state }
			);
			expect(res.status).toBe(400);
			expect(sessionCookie(res)).toBeUndefined();
		}
	});

	it('shows the page in the language used before going to Apple', async () => {
		// Apple からの POST には言語の Cookie が付かず、ブラウザの言語 (postForm は日本語) だけが届く。
		const flow = await startApple('/account/', 'en');
		const { res } = await back(flow, {}, { error: 'user_cancelled_authorize', state: flow.state });
		expect(await res.text()).toContain('Sign in to Mawok');
	});

	it('accepts the way back even when Apple sends no origin', async () => {
		const flow = await startApple();
		const { res } = await back(
			flow,
			{ sub: 'a-null-origin', email: 'null-origin@example.com' },
			{ code: 'c', state: flow.state },
			'null'
		);
		expect(res.status).toBe(303);
	});
});
