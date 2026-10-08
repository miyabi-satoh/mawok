import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { costOf } from '../../src/ai';
import { pricing } from '../../src/pricing';
import {
	accountId,
	buy,
	completed,
	geminiAnswers,
	grantsOf,
	linkApp,
	ORIGIN,
	postForm,
	request,
	sendAi,
	signIn,
	stripeSessions,
	webhook
} from '../helpers';

const { purchaseGrant: PURCHASE_GRANT } = pricing(env);

// 支払いの画面へ送る中身と、知らせを信じてよいかの決まりは test/stripe.test.ts で確かめる。
describe('buying credit', () => {
	async function ledgerOf(account: string) {
		return env.DB.prepare(
			`SELECT managed_payments, card_country, buyer_country, domestic, amount, currency FROM purchases
			 WHERE account_id = ?`
		)
			.bind(account)
			.first();
	}

	async function purchasedOf(account: string) {
		return (await grantsOf(account)).filter((g) => !g.free);
	}

	it('sends the buyer to Stripe Checkout with the account and the way back', async () => {
		const { cookie } = await signIn('buyer@example.com');
		const stripe = vi
			.spyOn(globalThis, 'fetch')
			// 応答は呼ばれた要求の中で作る (ほかの要求で作った本文は読めない)。
			.mockImplementation(async () =>
				Response.json({ id: 'cs_1', url: 'https://checkout.stripe.test/c/pay/cs_1' })
			);
		const res = await postForm('/account/buy', { next: '/account/' }, cookie);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('https://checkout.stripe.test/c/pay/cs_1');
		const [url, init] = stripe.mock.calls[0];
		expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
		const sent = new URLSearchParams(String(init!.body));
		expect(sent.get('client_reference_id')).toBe(await accountId('buyer@example.com'));
		expect(sent.get('customer_email')).toBe('buyer@example.com');
		expect(sent.get('metadata[buyer_country]')).toBe('JP');
		expect(sent.get('managed_payments[enabled]')).toBe('false');
		expect(sent.get('locale')).toBe('ja');
		expect(sent.get('success_url')).toBe(
			`${ORIGIN}/account/buy/done?next=%2Faccount%2F&lang=ja&session_id={CHECKOUT_SESSION_ID}`
		);
		expect(sent.get('cancel_url')).toBe(`${ORIGIN}/account/buy?lang=ja`);
		expect(sent.get('custom_text[submit][message]')).toContain(`${ORIGIN}/tokushoho/`);
		expect(new Headers(init!.headers).get('idempotency-key')).toMatch(/^mawok-checkout-/);
	});

	it('shows the final confirmation before payment, and links to it from the account page', async () => {
		const { cookie } = await signIn('offer@example.com');
		const home = await (await request('/account/', { cookie })).text();
		expect(home).toContain('href="/pricing/"');
		expect(home).not.toContain('action="/account/buy"');
		const confirmation = await (await request('/account/buy', { cookie })).text();
		// 最終確認画面に要る事項を、確定ボタンより上に出す。
		expect(confirmation).toContain('お申し込み内容の最終確認');
		expect(confirmation).toContain('Mawok の AI アクションのクレジット（期限なし）');
		expect(confirmation).toContain('300 円（税込み）');
		expect(confirmation).toContain('自動の更新はありません');
		expect(confirmation).toContain('返金');
		expect(confirmation).toContain('href="/tokushoho/"');
		expect(confirmation).toContain('action="/account/buy"');
		expect(confirmation.indexOf('返金')).toBeLessThan(
			confirmation.indexOf('申し込みを確定して支払いへ')
		);
	});

	it('shows Link refund policy on the overseas final confirmation', async () => {
		const { cookie } = await signIn('offer-abroad@example.com');
		const confirmation = await (await request('/account/buy', { cookie, country: 'US' })).text();
		expect(confirmation).toContain('Sold through Link, LLC');
		expect(confirmation).toContain('href="https://support.link.com/');
	});

	it('grants credit once from a paid checkout, however often Stripe resends it', async () => {
		await signIn('paid@example.com');
		const account = await accountId('paid@example.com');
		const stripe = stripeSessions(account);
		const event = completed('cs_paid', account);
		expect((await webhook(event)).status).toBe(200);
		expect((await webhook(event)).status).toBe(200);
		// 別の知らせ (completed の後の async_payment_succeeded など) でも二重には付けない。
		expect((await webhook(completed('cs_paid', account))).status).toBe(200);
		expect(await purchasedOf(account)).toEqual([
			{ free: 0, granted: PURCHASE_GRANT, remaining: PURCHASE_GRANT, revoked: 0 }
		]);
		// 処理し終えた知らせは、送り直されても Stripe に問い合わせ直さない。
		expect(stripe).toHaveBeenCalledTimes(2);
		expect(String(stripe.mock.calls[0][0])).toContain('/v1/checkout/sessions/cs_paid?');
		expect(await ledgerOf(account)).toEqual({
			managed_payments: 0,
			card_country: 'JP',
			buyer_country: 'JP',
			domestic: 1,
			amount: 300,
			currency: 'jpy'
		});
	});

	it('sells again: each purchase adds credit', async () => {
		await signIn('again@example.com');
		const account = await accountId('again@example.com');
		await buy(account, 'cs_again1');
		await buy(account, 'cs_again2');
		expect(await purchasedOf(account)).toHaveLength(2);
	});

	it('does not grant unpaid checkouts, other products, or unknown accounts', async () => {
		await signIn('unpaid@example.com');
		const account = await accountId('unpaid@example.com');
		await webhook(completed('cs_unpaid', account, { payment_status: 'unpaid' }));
		await webhook(completed('cs_other', account, { metadata: { product: 'weblav-pro' } }));
		expect(await purchasedOf(account)).toEqual([]);
		stripeSessions('no-such-account');
		expect((await webhook(completed('cs_ghost', 'no-such-account'))).status).toBe(200);
	});

	it('takes back what is left on a full refund or a dispute, but not what was used', async () => {
		const email = 'refund@example.com';
		const { token } = await linkApp(email);
		const account = await accountId(email);
		await buy(account, 'cs_refund');
		geminiAnswers({ total_input_tokens: 0, total_output_tokens: 8000 });
		await sendAi(token);
		vi.restoreAllMocks();
		const used = costOf({ total_input_tokens: 0, total_output_tokens: 8000 }, pricing(env).rates)!;
		const refund = (refunded: boolean) => ({
			id: `evt_${crypto.randomUUID()}`,
			type: 'charge.refunded',
			data: { object: { payment_intent: 'pi_cs_refund', refunded } }
		});
		await webhook(refund(false));
		expect((await purchasedOf(account))[0].remaining).toBe(PURCHASE_GRANT - used);
		await webhook(refund(true));
		expect(await purchasedOf(account)).toEqual([
			{ free: 0, granted: PURCHASE_GRANT, remaining: 0, revoked: PURCHASE_GRANT - used }
		]);
		// 台帳の行は消さず、取り消したことを残す。使った分の記録も残す。
		const row = await env.DB.prepare(
			'SELECT revoked_at FROM purchases WHERE stripe_checkout_session_id = ?'
		)
			.bind('cs_refund')
			.first<{ revoked_at: number | null }>();
		expect(row?.revoked_at).not.toBeNull();

		await buy(account, 'cs_dispute');
		await webhook({
			id: 'evt_dispute',
			type: 'charge.dispute.created',
			data: { object: { payment_intent: 'pi_cs_dispute' } }
		});
		expect((await purchasedOf(account))[1]).toMatchObject({
			remaining: 0,
			revoked: PURCHASE_GRANT
		});
	});

	it('does not grant a purchase whose refund arrived first', async () => {
		await signIn('early@example.com');
		const account = await accountId('early@example.com');
		await webhook({
			id: 'evt_early_refund',
			type: 'charge.refunded',
			data: { object: { payment_intent: 'pi_cs_early', refunded: true } }
		});
		await buy(account, 'cs_early');
		expect(await purchasedOf(account)).toEqual([]);
	});

	it('grants once per payment, even if two checkouts point to it', async () => {
		await signIn('samepi@example.com');
		const account = await accountId('samepi@example.com');
		stripeSessions(account, { payment_intent: { id: 'pi_shared', latest_charge: null } });
		await webhook(completed('cs_same1', account));
		await webhook(completed('cs_same2', account));
		expect(await purchasedOf(account)).toHaveLength(1);
	});

	it('grants once a delayed payment succeeds', async () => {
		await signIn('delayed@example.com');
		const account = await accountId('delayed@example.com');
		stripeSessions(account, { payment_status: 'unpaid' });
		await webhook(completed('cs_delayed', account, { payment_status: 'unpaid' }));
		expect(await purchasedOf(account)).toEqual([]);
		vi.restoreAllMocks();
		stripeSessions(account, {
			managed_payments: { enabled: true },
			metadata: { product: 'mawok-ai', buyer_country: 'US' },
			payment_intent: { id: 'pi_cs_delayed', latest_charge: { payment_method_details: {} } }
		});
		await webhook(
			completed('cs_delayed', account, {}, { type: 'checkout.session.async_payment_succeeded' })
		);
		expect(await purchasedOf(account)).toHaveLength(1);
		expect(await ledgerOf(account)).toEqual({
			managed_payments: 1,
			card_country: null,
			buyer_country: 'US',
			domestic: 0,
			amount: 300,
			currency: 'jpy'
		});
	});

	it('does not grant what Stripe does not confirm', async () => {
		await signIn('forgedbody@example.com');
		const account = await accountId('forgedbody@example.com');
		vi.spyOn(console, 'error').mockImplementation(() => {});
		stripeSessions(account, { amount_total: 1 });
		expect((await webhook(completed('cs_forged', account))).status).toBe(200);
		expect(await purchasedOf(account)).toEqual([]);
	});

	it('asks Stripe to send the notice again when it cannot confirm the purchase', async () => {
		await signIn('retry@example.com');
		const account = await accountId('retry@example.com');
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async () => new Response('{"error":{"type":"api_error"}}', { status: 500 })
		);
		const event = completed('cs_retry', account);
		expect((await webhook(event)).status).toBe(500);
		const failed = await env.DB.prepare('SELECT status FROM stripe_events WHERE id = ?')
			.bind(event.id)
			.first<{ status: string }>();
		expect(failed?.status).toBe('failed');
		vi.restoreAllMocks();
		stripeSessions(account);
		expect((await webhook(event)).status).toBe(200);
		expect(await purchasedOf(account)).toHaveLength(1);
	});

	it('sells through Managed Payments to buyers outside Japan', async () => {
		const { cookie } = await signIn('abroad@example.com');
		const stripe = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () =>
				Response.json({ id: 'cs_abroad', url: 'https://checkout.stripe.test/abroad' })
			);
		const res = await postForm('/account/buy', { next: '/account/' }, cookie, { country: 'US' });
		expect(res.status).toBe(303);
		const sent = new URLSearchParams(String(stripe.mock.calls[0][1]!.body));
		expect(sent.get('managed_payments[enabled]')).toBe('true');
		expect(sent.get('metadata[buyer_country]')).toBe('US');
		// 支払いの画面の文言は MP が決めるので、送らない。
		expect(sent.has('custom_text[submit][message]')).toBe(false);
	});

	it('sends back to the open checkout instead of opening another, until it is paid', async () => {
		const { cookie } = await signIn('twice@example.com');
		const account = await accountId('twice@example.com');
		let n = 0;
		const stripe = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			n += 1;
			return Response.json({ id: `cs_twice${n}`, url: `https://checkout.stripe.test/${n}` });
		});
		const first = await postForm('/account/buy', { next: '/account/' }, cookie);
		const second = await postForm('/account/buy', { next: '/account/' }, cookie);
		expect(second.headers.get('location')).toBe(first.headers.get('location'));
		expect(stripe).toHaveBeenCalledTimes(1);
		const sent = new URLSearchParams(String(stripe.mock.calls[0][1]!.body));
		expect(Number(sent.get('expires_at')) - Date.now() / 1000).toBeGreaterThanOrEqual(1790);
		vi.restoreAllMocks();
		// 払い終えたら、次の買い足しは新しい支払いの画面にする。
		await buy(account, 'cs_twice1');
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			Response.json({ id: 'cs_twice9', url: 'https://checkout.stripe.test/9' })
		);
		const third = await postForm('/account/buy', { next: '/account/' }, cookie);
		expect(third.headers.get('location')).toBe('https://checkout.stripe.test/9');
	});

	it('asks Stripe with the same key while the checkout has no page, so it stays one', async () => {
		const { cookie } = await signIn('race@example.com');
		const keys: string[] = [];
		const bodies: string[] = [];
		let reply = () => new Response('{"error":{"type":"idempotency_error"}}', { status: 409 });
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
			keys.push(new Headers(init!.headers).get('idempotency-key')!);
			bodies.push(String(init!.body));
			return reply();
		});
		// ほかのタブが頼んでいる最中: 予約は残し、押し直してもらう。
		const busy = await postForm('/account/buy', { next: '/account/link?code=ABCDEF' }, cookie);
		expect(busy.status).toBe(409);
		reply = () => Response.json({ id: 'cs_race', url: 'https://checkout.stripe.test/race' });
		// 押し直しは、戻り先やアクセス元の国が違っても最初の予約と同じ頼みにする (Stripe は中身の違う頼み直しを断る)。
		const again = await postForm('/account/buy', { next: '/account/' }, cookie, { country: 'US' });
		expect(again.headers.get('location')).toBe('https://checkout.stripe.test/race');
		expect(keys[1]).toBe(keys[0]);
		expect(bodies[1]).toBe(bodies[0]);
	});

	it('forgets the checkout when Stripe fails, so the next press starts over', async () => {
		const { cookie } = await signIn('fail@example.com');
		const keys: string[] = [];
		let reply = () => new Response('{"error":{"type":"api_error"}}', { status: 500 });
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
			keys.push(new Headers(init!.headers).get('idempotency-key')!);
			return reply();
		});
		expect((await postForm('/account/buy', { next: '/account/' }, cookie)).status).toBe(500);
		reply = () => Response.json({ id: 'cs_fail', url: 'https://checkout.stripe.test/fail' });
		const again = await postForm('/account/buy', { next: '/account/' }, cookie);
		expect(again.headers.get('location')).toBe('https://checkout.stripe.test/fail');
		expect(keys[1]).not.toBe(keys[0]);
	});

	it('asks again with the same key when no answer came back from Stripe', async () => {
		const { cookie } = await signIn('lost@example.com');
		const keys: string[] = [];
		let reply = (): Response => {
			throw new TypeError('network connection lost');
		};
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
			keys.push(new Headers(init!.headers).get('idempotency-key')!);
			return reply();
		});
		expect((await postForm('/account/buy', { next: '/account/' }, cookie)).status).toBe(500);
		reply = () => Response.json({ id: 'cs_lost', url: 'https://checkout.stripe.test/lost' });
		const again = await postForm('/account/buy', { next: '/account/' }, cookie);
		expect(again.headers.get('location')).toBe('https://checkout.stripe.test/lost');
		expect(keys[1]).toBe(keys[0]);
	});

	it('goes on once the purchase has arrived, and keeps checking until then', async () => {
		const { cookie } = await signIn('back@example.com');
		const account = await accountId('back@example.com');
		const path = '/account/buy/done?next=%2Faccount%2F&session_id=cs_back';
		const waiting = await request(path, { cookie });
		expect(waiting.status).toBe(200);
		expect(await waiting.text()).toContain('http-equiv="refresh"');
		const gaveUp = await (await request(`${path}&tries=10`, { cookie })).text();
		expect(gaveUp).not.toContain('http-equiv="refresh"');
		expect(gaveUp).toContain('tries=11');
		await buy(account, 'cs_back');
		const done = await request(path, { cookie, redirect: 'manual' });
		expect(done.status).toBe(303);
		expect(done.headers.get('location')).toBe('/account/?bought=1');
		expect(await (await request('/account/?bought=1', { cookie })).text()).toContain(
			'クレジットを買い足しました'
		);
	});
});
