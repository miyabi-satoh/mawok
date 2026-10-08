import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { linkPath, newLink, postForm, request, signIn } from '../helpers';

describe('email sign-in', () => {
	it('does not sign in by merely opening the link, and each link works once', async () => {
		const { token } = await signIn('once@example.com');
		const opened = await request(`/account/login/email?token=${token}`);
		expect(opened.headers.get('set-cookie')).toBeNull();
		const reused = await postForm('/account/login/email/verify', { token });
		expect(reused.status).toBe(400);
	});

	it('rejects an expired link', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		await postForm('/account/login/email', { email: 'late@example.com', next: '/account/' });
		const mail = String(log.mock.calls.at(-1)?.[0]);
		const token = new URL(mail.match(/http\S+/)![0]).searchParams.get('token')!;
		await env.DB.prepare(
			"UPDATE email_logins SET expires_at = 0 WHERE email = 'late@example.com'"
		).run();
		expect((await postForm('/account/login/email/verify', { token })).status).toBe(400);
	});

	it('refuses an address that cannot be sent to', async () => {
		const res = await postForm('/account/login/email', { email: 'not-an-address', next: '/' });
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('role="alert"');
	});

	it('keeps the same account for the same address in any case', async () => {
		await signIn('Same@Example.com');
		await signIn('same@example.com');
		const { n } = (await env.DB.prepare(
			"SELECT count(*) AS n FROM accounts WHERE email = 'same@example.com'"
		).first<{ n: number }>())!;
		expect(n).toBe(1);
	});

	it('limits how many links go to one address per hour', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		// 送り主の IP を毎回変え、IP ごとの上限ではなくアドレスごとの上限で止まるのを見る。同時に送っても超えない。
		const email = 'flood@example.com';
		const statuses = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				postForm('/account/login/email', { email, next: '/account/' }, undefined, {
					ip: `203.0.113.${i}`
				})
			)
		).then((res) => res.map((r) => r.status));
		expect(statuses.filter((s) => s === 200)).toHaveLength(5);
		expect(statuses.filter((s) => s === 429)).toHaveLength(3);
	});

	it('signs out', async () => {
		const { cookie } = await signIn('bye@example.com');
		expect(await (await request('/account/', { cookie })).text()).toContain('bye@example.com');
		await postForm('/account/logout', { next: '/account/' }, cookie);
		expect(await (await request('/account/', { cookie })).text()).toContain('Mawok にサインイン');
	});
});

describe('sign-in page', () => {
	it('serves the account page with or without the trailing slash', async () => {
		for (const path of ['/account', '/account/']) {
			expect(await (await request(path)).text()).toContain('Mawok にサインイン');
		}
	});

	it('links to the product page, and says that signing in agrees to the terms and the privacy policy', async () => {
		const page = await (await request('/account/?lang=ja')).text();
		expect(page).toContain('href="/"');
		const consent = page.slice(page.indexOf('サインインすると'), page.indexOf('に同意'));
		expect(consent).toContain('href="/terms/"');
		expect(consent).toContain('href="/privacy/"');
		expect(page).toContain('アメリカ合衆国の事業者');
	});

	it('offers Google and Apple', async () => {
		const page = await (await request('/account/?lang=ja')).text();
		expect(page).toContain('href="/account/login/google?next=%2Faccount%2F"');
		expect(page).toContain('href="/account/login/apple?next=%2Faccount%2F"');
		expect(page).toContain('Appleでサインイン');
	});
});

// 言語の選び方は test/i18n.test.ts で確かめる。
describe('language', () => {
	const heading = async (res: Response) => (await res.text()).match(/<h1>(.*?)<\/h1>/)?.[1];

	it('keeps the language given in the link on the following pages', async () => {
		const res = await request(`${linkPath((await newLink()).fields)}&lang=en`);
		expect(await heading(res)).toBe('Sign in to Mawok');
		const cookie = res.headers.get('set-cookie')!.split(';')[0];
		expect(cookie).toBe('lang=en');
		expect(await heading(await request('/account/', { cookie }))).toBe('Sign in to Mawok');
	});

	it('sends the mail in the same language, with the language in the link', async () => {
		// Mawok から開いたときに残した cookie で決まる。フォームの送り先には言語が付かない。
		const opened = await request(`${linkPath((await newLink()).fields)}&lang=en`);
		const cookie = opened.headers.get('set-cookie')!.split(';')[0];
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const sent = await postForm(
			'/account/login/email',
			{ email: 'english@example.com', next: '/account/' },
			cookie
		);
		expect(await sent.text()).toContain('Check your email');
		const mail = String(log.mock.calls.at(-1)?.[0]);
		expect(mail).toContain('Open the following link');
		expect(new URL(mail.match(/http\S+/)![0]).searchParams.get('lang')).toBe('en');
	});
});
