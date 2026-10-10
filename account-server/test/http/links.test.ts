import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import {
	app,
	approve,
	exchange,
	linkApp,
	linkPath,
	newLink,
	postForm,
	request,
	signIn
} from '../helpers';

describe('linking Mawok', () => {
	it('signs in first, then sends the browser back to Mawok with a one-time code', async () => {
		const email = 'owner@example.com';
		const { verifier, fields } = await newLink('Taro の MacBook');

		// サインインしていなければ、サインインの画面を出し、終わったら結ぶ画面へ戻す。
		const before = await request(linkPath(fields));
		expect(await before.text()).toContain('Mawok にサインイン');
		const { cookie, location } = await signIn(email, linkPath(fields));
		expect(location).toBe(linkPath(fields));

		const page = await (await request(location!, { cookie })).text();
		expect(page).toContain('「Taro の MacBook」をこのアカウントに登録します');
		expect(page).toContain('このデバイスを登録');

		const code = await approve(fields, cookie);
		const answer = await exchange(code, verifier);
		expect(answer.status).toBe(200);
		const { token } = await answer.json<{ token: string }>();
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		// トークンそのものは持たず、ハッシュだけを持つ。
		expect(
			await env.DB.prepare('SELECT 1 FROM app_tokens WHERE token_hash = ?').bind(token).first()
		).toBeNull();
		// 答えの形は test/http/balance.test.ts が見る。ここは、替えたトークンでこのアカウントに届くことだけを見る。
		expect(await (await app('/v1/balance', token)).json()).toMatchObject({ email });
		// 窓口の画面で、どのデバイスの Mawok かが分かる。
		expect(await (await request('/account/', { cookie })).text()).toContain('Taro の MacBook（');
	});

	it('asks to open the mail link on the same computer only while linking', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { fields } = await newLink();
		const linking = await postForm('/account/login/email', {
			email: 'same@example.com',
			next: linkPath(fields)
		});
		expect(await linking.text()).toContain('Mawok を使っているこのデバイスで開いてください');
		expect(String(log.mock.calls.at(-1)?.[0])).toContain('Mawok を使っている PC で開いてください');
		const plain = await postForm('/account/login/email', {
			email: 'same@example.com',
			next: '/account/'
		});
		expect(await plain.text()).not.toContain('このパソコンで');
		expect(String(log.mock.calls.at(-1)?.[0])).not.toContain('パソコンで');
	});

	it('hands out a token once, and only with the verifier', async () => {
		const { cookie } = await signIn('verifier@example.com');
		const { verifier, fields } = await newLink();
		const code = await approve(fields, cookie);
		// 検証用の値が違えば替えず、そのコードはそれきり使えない。
		expect((await exchange(code, 'f'.repeat(64))).status).toBe(400);
		expect((await exchange(code, verifier)).status).toBe(400);

		const again = await approve(fields, cookie);
		expect((await exchange(again, verifier)).status).toBe(200);
		expect((await exchange(again, verifier)).status).toBe(400);
		expect((await exchange('missing', verifier)).status).toBe(400);
	});

	it('refuses an expired code', async () => {
		const { cookie } = await signIn('late-code@example.com');
		const { verifier, fields } = await newLink();
		const code = await approve(fields, cookie);
		await env.DB.prepare(
			"UPDATE link_codes SET expires_at = 1 WHERE account_id = (SELECT id FROM accounts WHERE email = 'late-code@example.com')"
		).run();
		expect((await exchange(code, verifier)).status).toBe(400);
	});

	// 申し込みの値の確かめ (src/index.ts の linkRequest) は export されていないので、ここで場合ごとに確かめる。
	it('only goes back to a port on 127.0.0.1 with well-formed values', async () => {
		const { cookie } = await signIn('shape@example.com');
		const { fields } = await newLink();
		for (const bad of [
			{ port: '80' },
			{ port: '70000' },
			{ port: 'evil.test' },
			{ state: 'x' },
			{ challenge: 'short' }
		]) {
			const query = { ...fields, ...bad };
			expect((await request(linkPath(query), { cookie })).status).toBe(400);
			expect((await postForm('/account/link', query, cookie)).status).toBe(400);
		}
		// 名前が無くても結べる。窓口の画面には「Mawok」と出す。
		const { verifier, fields: unnamed } = await newLink('  ');
		const code = await approve(unnamed, cookie);
		expect((await exchange(code, verifier)).status).toBe(200);
		expect(await (await request('/account/', { cookie })).text()).toContain('Mawok（');
	});
});

describe('app tokens', () => {
	it('signs Mawok out, and the token stops working', async () => {
		const { token } = await linkApp('signout@example.com');
		expect((await app('/v1/token', token, { method: 'DELETE' })).status).toBe(204);
		expect((await app('/v1/balance', token)).status).toBe(401);
	});

	it('lists linked Mawok on the account page and removes one from there', async () => {
		const { cookie, token } = await linkApp('apps@example.com');
		const home = await (await request('/account/', { cookie })).text();
		expect(home).toContain('登録しているデバイス');
		const id = home.match(/name="id" value="([0-9a-f]+)"/)![1];
		// ほかのアカウントからは外せない。
		const other = await signIn('not-mine@example.com');
		await postForm('/account/apps/unlink', { id }, other.cookie);
		expect((await app('/v1/balance', token)).status).toBe(200);
		expect((await postForm('/account/apps/unlink', { id }, cookie)).status).toBe(303);
		expect((await app('/v1/balance', token)).status).toBe(401);
		expect(await (await request('/account/', { cookie })).text()).toContain(
			'登録しているデバイスはありません'
		);
	});
});
