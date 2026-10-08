import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { accountId, grantsOf, ORIGIN, request, sessionCookie, signIn } from '../helpers';

describe('Google sign-in', () => {
	/** Google の画面へ送り、戻ってきたときに要る Cookie と state・nonce を返す。 */
	async function startGoogle(next = '/account/') {
		const res = await request(`/account/login/google?next=${encodeURIComponent(next)}`, {
			redirect: 'manual'
		});
		expect(res.status).toBe(303);
		const to = new URL(res.headers.get('location')!);
		expect(`${to.origin}${to.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(to.searchParams.get('code_challenge_method')).toBe('S256');
		expect(to.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/account/login/google/callback`);
		return {
			cookie: res.headers.get('set-cookie')!.split(';')[0],
			state: to.searchParams.get('state')!,
			nonce: to.searchParams.get('nonce')!
		};
	}

	async function back(
		flow: { cookie: string; state: string; nonce: string },
		claims: Record<string, unknown> = {},
		state = flow.state
	) {
		const body = btoa(
			JSON.stringify({
				iss: 'https://accounts.google.com',
				aud: 'google-client',
				exp: Math.floor(Date.now() / 1000) + 300,
				nonce: flow.nonce,
				sub: 'google-sub-1',
				email: 'g@example.com',
				email_verified: true,
				// Google Workspace のアカウント。Google が持ち主を確かだと言える。
				hd: 'example.com',
				...claims
			})
		).replaceAll('=', '');
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			Response.json({ id_token: `e30.${body}.sig` })
		);
		return request(`/account/login/google/callback?code=c&state=${state}`, {
			cookie: flow.cookie,
			redirect: 'manual'
		});
	}

	it('signs in a new account with free credit and comes back to the same account next time', async () => {
		const first = await back(await startGoogle('/account/link?code=ABCDEF'), {
			sub: 'g-new',
			email: 'G-New@Example.com'
		});
		expect(first.status).toBe(303);
		expect(first.headers.get('location')).toBe('/account/link?code=ABCDEF');
		const home = await (await request('/account/', { cookie: sessionCookie(first) })).text();
		expect(home).toContain('g-new@example.com');
		expect(await grantsOf(await accountId('g-new@example.com'))).toHaveLength(1);
		// Google でメールアドレスを変えても、識別子で同じアカウントに入る。
		const again = await back(await startGoogle(), { sub: 'g-new', email: 'renamed@example.com' });
		const page = await (await request('/account/', { cookie: sessionCookie(again) })).text();
		expect(page).toContain('g-new@example.com');
	});

	it('joins the account that signed in by email with the same verified address', async () => {
		await signIn('email-then-google@example.com');
		const res = await back(await startGoogle(), {
			sub: 'g-both',
			email: 'email-then-google@example.com'
		});
		const home = await (await request('/account/', { cookie: sessionCookie(res) })).text();
		expect(home).toContain('email-then-google@example.com');
		const { n } = (await env.DB.prepare(
			"SELECT count(*) AS n FROM accounts WHERE email = 'email-then-google@example.com'"
		).first<{ n: number }>())!;
		expect(n).toBe(1);
	});

	it('refuses addresses whose owner Google cannot vouch for, and keeps the way back', async () => {
		for (const claims of [
			{ sub: 'g-unverified', email: 'unverified@example.com', email_verified: false },
			// Gmail でも Workspace でもないアドレスは、作ったときに確かめただけで、今の持ち主かは分からない。
			{ sub: 'g-third-party', email: 'third-party@example.com', hd: undefined }
		]) {
			vi.restoreAllMocks();
			const res = await back(await startGoogle('/account/link?code=ABCDEF'), claims);
			expect(res.status).toBe(400);
			expect(sessionCookie(res)).toBeUndefined();
			expect(await res.text()).toContain('value="/account/link?code=ABCDEF"');
			expect(
				await env.DB.prepare('SELECT 1 FROM accounts WHERE email = ?').bind(claims.email).first()
			).toBeNull();
		}
	});

	it('accepts a Gmail address without a hosted domain', async () => {
		const res = await back(await startGoogle(), {
			sub: 'g-gmail',
			email: 'someone@gmail.com',
			hd: undefined
		});
		expect(res.status).toBe(303);
		expect(sessionCookie(res)).toBeDefined();
	});

	it('does not link a second Google account to the same account', async () => {
		await back(await startGoogle(), { sub: 'g-first', email: 'twice-g@example.com' });
		const res = await back(await startGoogle(), { sub: 'g-second', email: 'twice-g@example.com' });
		expect(res.status).toBe(409);
		expect(sessionCookie(res)).toBeUndefined();
	});

	// ID トークンの確かめは finishGoogleSignIn (Context を取る) の中にあり、切り出していないので、ここで場合ごとに確かめる。
	// 往復を始めていない (Cookie が無い) ときは test/http/guards.test.ts で確かめる。
	it('rejects a wrong state, nonce, audience or an expired token', async () => {
		for (const [claims, state] of [
			[{}, 'wrong-state'],
			[{ nonce: 'other' }, undefined],
			[{ aud: 'someone-else' }, undefined],
			[{ iss: 'https://evil.test' }, undefined],
			[{ exp: Math.floor(Date.now() / 1000) - 1 }, undefined]
		] as const) {
			vi.restoreAllMocks();
			const flow = await startGoogle();
			const res = await back(
				flow,
				{ sub: 'g-bad', email: 'bad@example.com', ...claims },
				state ?? flow.state
			);
			expect(res.status).toBe(400);
			expect(sessionCookie(res)).toBeUndefined();
		}
	});
});
