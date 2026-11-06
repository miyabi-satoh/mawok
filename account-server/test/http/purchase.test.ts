import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { accountId, addSubscription, ORIGIN, postForm, request, signIn, webhook } from '../helpers';

// 支払いの画面へ送る中身と、知らせを信じてよいかの決まりは test/stripe.test.ts で確かめる。
describe('subscribing to Pro', () => {
	function proInvoiceApi(
		account: string,
		{
			subscriptionId = `sub_${crypto.randomUUID()}`,
			invoiceId = `in_${crypto.randomUUID()}`,
			managedPayments = false,
			buyerCountry = 'JP',
			customerCountry = 'JP',
			cardCountry = 'JP',
			status = 'active',
			price = 'price_pro_monthly',
			cancelAtPeriodEnd = false,
			cancelAt = null
		}: {
			subscriptionId?: string;
			invoiceId?: string;
			managedPayments?: boolean;
			buyerCountry?: string;
			customerCountry?: string | null;
			cardCountry?: string | null;
			status?: string;
			price?: string;
			cancelAtPeriodEnd?: boolean;
			cancelAt?: number | null;
		} = {}
	) {
		const paymentIntentId = `pi_${subscriptionId}`;
		const stripe = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			const path = new URL(String(url)).pathname;
			if (path.endsWith(`/invoices/${invoiceId}`))
				return Response.json({
					id: invoiceId,
					status: 'paid',
					total: 480,
					amount_paid: 480,
					currency: 'jpy',
					customer_details: { address: customerCountry ? { country: customerCountry } : null },
					parent: { subscription_details: { subscription: subscriptionId } },
					lines: {
						has_more: false,
						data: [
							{
								amount: 480,
								currency: 'jpy',
								quantity: 1,
								period: { end: 2_000_000_000 },
								pricing: { price_details: { price } },
								discount_amounts: []
							}
						]
					},
					payments: {
						has_more: false,
						data: [
							{
								status: 'paid',
								amount_paid: 480,
								payment: {
									type: 'payment_intent',
									payment_intent: {
										id: paymentIntentId,
										latest_charge: cardCountry ? `ch_${subscriptionId}` : null
									}
								}
							}
						]
					}
				});
			if (path.endsWith(`/subscriptions/${subscriptionId}`)) {
				if (init?.method === 'DELETE') return Response.json({});
				return Response.json({
					id: subscriptionId,
					status,
					cancel_at_period_end: cancelAtPeriodEnd,
					cancel_at: cancelAt,
					customer: `cus_${subscriptionId}`,
					metadata: {
						product: 'mawok-pro',
						account_id: account,
						managed_payments: managedPayments ? '1' : '0',
						buyer_country: buyerCountry
					},
					items: {
						data: [
							{
								current_period_end: 2_000_000_000,
								price: { id: price, currency: 'jpy' }
							}
						]
					}
				});
			}
			if (path.endsWith(`/charges/ch_${subscriptionId}`))
				return Response.json({ payment_method_details: { card: { country: cardCountry } } });
			throw new Error(`Unexpected Stripe request: ${path}`);
		});
		return { subscriptionId, invoiceId, paymentIntentId, stripe };
	}

	function refunded(paymentIntentId: string) {
		return {
			id: `evt_${crypto.randomUUID()}`,
			type: 'charge.refunded',
			data: { object: { payment_intent: paymentIntentId, refunded: true } }
		};
	}

	/** Stripe の側のサブスクを打ち切ったか。 */
	function canceledOnStripe(stripe: ReturnType<typeof proInvoiceApi>['stripe'], id: string) {
		return stripe.mock.calls.some(
			([url, init]) => String(url).endsWith(`/subscriptions/${id}`) && init?.method === 'DELETE'
		);
	}

	function paidInvoice(invoiceId: string) {
		return {
			id: `evt_${crypto.randomUUID()}`,
			type: 'invoice.paid',
			data: { object: { id: invoiceId } }
		};
	}

	it('shows a Pro trial confirmation for a selected plan, and gives Checkout the same note with or without a trial', async () => {
		// サインインの前に開いても、サインインの後に選んだプランの最終確認へ戻る。
		expect(await (await request('/account/buy?plan=monthly')).text()).toContain(
			'name="next" value="/account/buy?plan=monthly"'
		);
		const { cookie } = await signIn('pro-offer@example.com');
		const confirmation = await (await request('/account/buy?plan=monthly', { cookie })).text();
		// 文言の出し分けは test/pages.test.ts が見る。ここは、初めての申し込みが試用つきの画面に届くことだけを見る。
		expect(confirmation).toMatch(/\d{4}\/\d{1,2}\/\d{1,2} に最初の 480 円を支払い/);
		expect(confirmation.indexOf('解約と返金')).toBeLessThan(
			confirmation.indexOf('申し込みを確定して支払いへ')
		);
		expect(confirmation).toMatch(/name="plan"\s+value="monthly"/);

		const stripe = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () =>
				Response.json({ id: `cs_${crypto.randomUUID()}`, url: 'https://checkout.stripe.test/pro' })
			);
		expect(
			(await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie)).status
		).toBe(303);
		const trialNote = new URLSearchParams(String(stripe.mock.calls[0][1]!.body)).get(
			'custom_text[submit][message]'
		);

		const account = await accountId('pro-offer@example.com');
		await addSubscription(account, { id: 'sub_pro_offer', paidThrough: 0, status: 'canceled' });
		await env.DB.prepare('DELETE FROM checkouts WHERE account_id = ?').bind(account).run();
		expect(
			(await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie)).status
		).toBe(303);
		const noTrialNote = new URLSearchParams(String(stripe.mock.calls[1][1]!.body)).get(
			'custom_text[submit][message]'
		);
		expect(noTrialNote).toBe(trialNote);
		expect(noTrialNote).not.toContain('無料');
		expect(noTrialNote).toContain('解約するまで自動で更新します。');
	});

	it('shows the trial charge date, then renewal or cancellation on the account page', async () => {
		const { cookie } = await signIn('pro-status@example.com');
		const account = await accountId('pro-status@example.com');
		await addSubscription(account, { id: 'sub_pro_status', customer: 'cus_pro_status' });
		let page = await (await request('/account/', { cookie })).text();
		expect(page).toContain('から課金が始まります');
		expect(page).toContain('「支払いを管理」から解約');
		await env.DB.prepare('UPDATE subscriptions SET cancel_at_period_end = 1 WHERE id = ?')
			.bind('sub_pro_status')
			.run();
		page = await (await request('/account/', { cookie })).text();
		expect(page).toContain('試用は');
		expect(page).toContain('課金はされません');
		await env.DB.prepare('UPDATE subscriptions SET cancel_at_period_end = 0 WHERE id = ?')
			.bind('sub_pro_status')
			.run();
		await env.DB.prepare(
			`INSERT INTO purchases (id, account_id, product, stripe_checkout_session_id, stripe_payment_intent_id,
			 amount, currency, managed_payments, domestic, stripe_subscription_id, created_at)
			 VALUES ('purchase_pro_status', ?, 'mawok-pro', 'invoice:pro-status', 'pi_pro_status',
			 480, 'jpy', 0, 1, 'sub_pro_status', 0)`
		)
			.bind(account)
			.run();
		page = await (await request('/account/', { cookie })).text();
		expect(page).toContain('に自動で更新されます');
		await env.DB.prepare('UPDATE subscriptions SET cancel_at_period_end = 1 WHERE id = ?')
			.bind('sub_pro_status')
			.run();
		page = await (await request('/account/', { cookie })).text();
		expect(page).toContain('まで使えます (更新されません)');
		await env.DB.prepare(
			'UPDATE subscriptions SET cancel_at_period_end = 0, status = ? WHERE id = ?'
		)
			.bind('canceled', 'sub_pro_status')
			.run();
		page = await (await request('/account/', { cookie })).text();
		expect(page).toContain('まで使えます (更新されません)');
	});

	it('shows cancel_at instead of the paid-through date when Stripe set it', async () => {
		const { cookie } = await signIn('pro-cancel-at@example.com');
		const account = await accountId('pro-cancel-at@example.com');
		const cancelAt = Date.UTC(2099, 11, 15) / 1000;
		await addSubscription(account, {
			id: 'sub_pro_cancel_at',
			status: 'active',
			cancelAtPeriodEnd: true,
			cancelAt
		});
		await env.DB.prepare(
			`INSERT INTO purchases (id, account_id, product, stripe_checkout_session_id, stripe_payment_intent_id,
			 amount, currency, managed_payments, domestic, stripe_subscription_id, created_at)
			 VALUES ('purchase_pro_cancel_at', ?, 'mawok-pro', 'invoice:cancel-at', 'pi_cancel_at',
			 480, 'jpy', 0, 1, 'sub_pro_cancel_at', 0)`
		)
			.bind(account)
			.run();
		const page = await (await request('/account/', { cookie })).text();
		const date = new Date(cancelAt * 1000).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
		expect(page).toContain(`${date} まで使えます (更新されません)`);
	});

	it('keeps an overseas Pro invoice as a ledger entry but not a subscription after its account is deleted', async () => {
		await signIn('gone-pro@example.com');
		const account = await accountId('gone-pro@example.com');
		await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(account).run();
		const { subscriptionId, invoiceId, stripe } = proInvoiceApi(account, {
			managedPayments: true,
			buyerCountry: 'US',
			customerCountry: 'US',
			cardCountry: null
		});
		expect((await webhook(paidInvoice(invoiceId))).status).toBe(200);
		expect(
			await env.DB.prepare('SELECT 1 FROM subscriptions WHERE id = ?').bind(subscriptionId).first()
		).toBeNull();
		expect(
			await env.DB.prepare(
				`SELECT account_id, managed_payments, card_country, buyer_country, domestic
				 FROM purchases WHERE stripe_subscription_id = ?`
			)
				.bind(subscriptionId)
				.first()
		).toEqual({
			account_id: null,
			managed_payments: 1,
			card_country: null,
			buyer_country: 'US',
			domestic: 0
		});
		expect(canceledOnStripe(stripe, subscriptionId)).toBe(true);
	});

	it('ends Pro and cancels the subscription on a refunded Pro payment', async () => {
		const { cookie } = await signIn('pro-refund@example.com');
		const account = await accountId('pro-refund@example.com');
		const { subscriptionId, invoiceId, paymentIntentId, stripe } = proInvoiceApi(account);
		await webhook(paidInvoice(invoiceId));
		expect(await (await request('/account/', { cookie })).text()).toContain('に自動で更新されます');
		await webhook(refunded(paymentIntentId));
		expect(
			await env.DB.prepare('SELECT revoked_at FROM subscriptions WHERE id = ?')
				.bind(subscriptionId)
				.first<{ revoked_at: number | null }>()
		).toMatchObject({ revoked_at: expect.any(Number) });
		expect(
			await env.DB.prepare('SELECT revoked_at FROM purchases WHERE stripe_subscription_id = ?')
				.bind(subscriptionId)
				.first<{ revoked_at: number | null }>()
		).toMatchObject({ revoked_at: expect.any(Number) });
		expect(await (await request('/account/', { cookie })).text()).toContain('Pro の料金を見る');
		expect(canceledOnStripe(stripe, subscriptionId)).toBe(true);
	});

	it('keeps the earlier subscription when the later of two paid Pro subscriptions is refunded', async () => {
		await signIn('duplicate-refund@example.com');
		const account = await accountId('duplicate-refund@example.com');
		const first = proInvoiceApi(account);
		await webhook(paidInvoice(first.invoiceId));
		vi.restoreAllMocks();
		const second = proInvoiceApi(account);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await webhook(paidInvoice(second.invoiceId));
		await webhook(refunded(second.paymentIntentId));
		expect(
			await env.DB.prepare('SELECT revoked_at FROM subscriptions WHERE id = ?')
				.bind(first.subscriptionId)
				.first()
		).toEqual({ revoked_at: null });
	});

	it('asks Stripe to send the notice again when it cannot confirm the invoice', async () => {
		await signIn('retry@example.com');
		const account = await accountId('retry@example.com');
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async () => new Response('{"error":{"type":"api_error"}}', { status: 500 })
		);
		const invoiceId = `in_${crypto.randomUUID()}`;
		const event = paidInvoice(invoiceId);
		expect((await webhook(event)).status).toBe(500);
		expect(
			await env.DB.prepare('SELECT status FROM stripe_events WHERE id = ?').bind(event.id).first()
		).toEqual({ status: 'failed' });
		vi.restoreAllMocks();
		const { subscriptionId } = proInvoiceApi(account, { invoiceId });
		expect((await webhook(event)).status).toBe(200);
		expect(
			await env.DB.prepare('SELECT account_id FROM subscriptions WHERE id = ?')
				.bind(subscriptionId)
				.first()
		).toEqual({ account_id: account });
	});

	it('records an unaccepted Pro invoice as failed and reports it to the operator log', async () => {
		await signIn('bad-pro-invoice@example.com');
		const account = await accountId('bad-pro-invoice@example.com');
		const { invoiceId } = proInvoiceApi(account, { price: 'price_not_pro' });
		const event = paidInvoice(invoiceId);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect((await webhook(event)).status).toBe(200);
		expect(
			await env.DB.prepare('SELECT status FROM stripe_events WHERE id = ?').bind(event.id).first()
		).toEqual({ status: 'failed' });
		expect(logged).toHaveBeenCalledWith(
			expect.stringContaining('請求書で Pro を付けられませんでした')
		);
	});

	it('records both Stripe cancellation markers in subscription updates', async () => {
		await signIn('pro-cancel-at-period-end@example.com');
		const account = await accountId('pro-cancel-at-period-end@example.com');
		const first = proInvoiceApi(account, { cancelAt: 1_999_999_999 });
		await webhook(paidInvoice(first.invoiceId));
		expect(
			await env.DB.prepare('SELECT cancel_at_period_end, cancel_at FROM subscriptions WHERE id = ?')
				.bind(first.subscriptionId)
				.first()
		).toEqual({ cancel_at_period_end: 0, cancel_at: 1_999_999_999 });
		vi.restoreAllMocks();
		proInvoiceApi(account, {
			subscriptionId: first.subscriptionId,
			cancelAt: 2_000_000_000
		});
		await webhook({
			id: `evt_${crypto.randomUUID()}`,
			type: 'customer.subscription.updated',
			data: { object: { id: first.subscriptionId } }
		});
		expect(
			await env.DB.prepare('SELECT cancel_at_period_end, cancel_at FROM subscriptions WHERE id = ?')
				.bind(first.subscriptionId)
				.first()
		).toEqual({ cancel_at_period_end: 0, cancel_at: 2_000_000_000 });
	});

	it('cancels and reports a second active Pro subscription while retaining its ledger entry', async () => {
		await signIn('duplicate-pro@example.com');
		const account = await accountId('duplicate-pro@example.com');
		const first = proInvoiceApi(account);
		await webhook(paidInvoice(first.invoiceId));
		vi.restoreAllMocks();
		const second = proInvoiceApi(account);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const event = paidInvoice(second.invoiceId);
		expect((await webhook(event)).status).toBe(200);
		expect(
			await env.DB.prepare('SELECT 1 FROM subscriptions WHERE id = ?')
				.bind(second.subscriptionId)
				.first()
		).toBeNull();
		expect(
			await env.DB.prepare(
				'SELECT account_id, revoked_at FROM purchases WHERE stripe_subscription_id = ?'
			)
				.bind(second.subscriptionId)
				.first()
		).toEqual({ account_id: account, revoked_at: null });
		expect(canceledOnStripe(second.stripe, second.subscriptionId)).toBe(true);
		expect(
			await env.DB.prepare('SELECT status FROM stripe_events WHERE id = ?').bind(event.id).first()
		).toEqual({ status: 'failed' });
		expect(logged).toHaveBeenCalledWith(
			expect.stringContaining('まだ有効な別の Pro のサブスクがあります')
		);
		vi.restoreAllMocks();
	});

	it('accepts a new Pro subscription after the earlier one ended at cancel_at', async () => {
		await signIn('resubscribe-after-cancel@example.com');
		const account = await accountId('resubscribe-after-cancel@example.com');
		const first = proInvoiceApi(account, { cancelAt: 1 });
		await webhook(paidInvoice(first.invoiceId));
		vi.restoreAllMocks();
		const second = proInvoiceApi(account);
		await webhook(paidInvoice(second.invoiceId));
		expect(
			await env.DB.prepare('SELECT account_id FROM subscriptions WHERE id = ?')
				.bind(second.subscriptionId)
				.first()
		).toEqual({ account_id: account });
		expect(canceledOnStripe(second.stripe, second.subscriptionId)).toBe(false);
		vi.restoreAllMocks();
	});

	it('does not report a duplicate when a Pro payment was revoked before its invoice', async () => {
		await signIn('revoked-not-duplicate@example.com');
		const account = await accountId('revoked-not-duplicate@example.com');
		const first = proInvoiceApi(account);
		await webhook(paidInvoice(first.invoiceId));
		vi.restoreAllMocks();
		const second = proInvoiceApi(account);
		await webhook(refunded(second.paymentIntentId));
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const event = paidInvoice(second.invoiceId);
		await webhook(event);
		expect(logged).not.toHaveBeenCalled();
		expect(
			await env.DB.prepare('SELECT status FROM stripe_events WHERE id = ?').bind(event.id).first()
		).toEqual({ status: 'done' });
		vi.restoreAllMocks();
	});

	it('does not report a duplicate when Stripe already canceled the later subscription', async () => {
		await signIn('canceled-not-duplicate@example.com');
		const account = await accountId('canceled-not-duplicate@example.com');
		const first = proInvoiceApi(account);
		await webhook(paidInvoice(first.invoiceId));
		vi.restoreAllMocks();
		const second = proInvoiceApi(account, { status: 'canceled' });
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const event = paidInvoice(second.invoiceId);
		await webhook(event);
		expect(logged).not.toHaveBeenCalled();
		expect(
			await env.DB.prepare('SELECT status FROM stripe_events WHERE id = ?').bind(event.id).first()
		).toEqual({ status: 'done' });
		vi.restoreAllMocks();
	});

	it('expires the open checkout before switching between plans', async () => {
		const { cookie } = await signIn('switch-checkout@example.com');
		let created = 0;
		const stripe = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (String(url).endsWith('/expire')) return Response.json({});
			created += 1;
			return Response.json({
				id: `cs_switch_${created}`,
				url: `https://checkout.stripe.test/${created}`
			});
		});
		await postForm('/account/buy', { next: '/account/', plan: 'yearly' }, cookie);
		await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie);
		await postForm('/account/buy', { next: '/account/', plan: 'yearly' }, cookie);
		const expired = stripe.mock.calls
			.filter(([url]) => String(url).endsWith('/expire'))
			.map(([url]) => String(url));
		expect(expired).toEqual([
			'https://api.stripe.com/v1/checkout/sessions/cs_switch_1/expire',
			'https://api.stripe.com/v1/checkout/sessions/cs_switch_2/expire'
		]);
	});

	it('replaces the checkout reservation when expiring its Stripe session fails', async () => {
		const { cookie } = await signIn('replace-broken-checkout@example.com');
		let created = 0;
		let expirations = 0;
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (String(url).endsWith('/expire')) {
				expirations += 1;
				if (expirations === 1) return new Response('temporary failure', { status: 500 });
				throw new TypeError('network failure');
			}
			created += 1;
			return Response.json({
				id: `cs_replace_${created}`,
				url: `https://checkout.stripe.test/replace/${created}`
			});
		});
		await postForm('/account/buy', { next: '/account/', plan: 'yearly' }, cookie);
		expect(
			(await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie)).status
		).toBe(303);
		expect(
			(await postForm('/account/buy', { next: '/account/', plan: 'yearly' }, cookie)).status
		).toBe(303);
		expect(logged).toHaveBeenCalledTimes(2);
		expect(
			await env.DB.prepare('SELECT price, session_id FROM checkouts WHERE account_id = ?')
				.bind(await accountId('replace-broken-checkout@example.com'))
				.first()
		).toEqual({ price: 'yearly', session_id: 'cs_replace_3' });
		logged.mockRestore();
	});

	it('does not grant or extend Pro for a payment revoked before its invoice, and cancels it', async () => {
		await signIn('revoked-pro@example.com');
		const account = await accountId('revoked-pro@example.com');
		const { subscriptionId, invoiceId, paymentIntentId, stripe } = proInvoiceApi(account);
		await webhook(refunded(paymentIntentId));
		expect((await webhook(paidInvoice(invoiceId))).status).toBe(200);
		expect(
			await env.DB.prepare('SELECT 1 FROM subscriptions WHERE id = ?').bind(subscriptionId).first()
		).toBeNull();
		expect(
			await env.DB.prepare('SELECT revoked_at FROM purchases WHERE stripe_subscription_id = ?')
				.bind(subscriptionId)
				.first<{ revoked_at: number | null }>()
		).toMatchObject({ revoked_at: expect.any(Number) });
		expect(canceledOnStripe(stripe, subscriptionId)).toBe(true);
	});

	it('never restores a canceled Pro subscription from a late paid invoice', async () => {
		await signIn('canceled-pro@example.com');
		const account = await accountId('canceled-pro@example.com');
		const subscriptionId = `sub_${crypto.randomUUID()}`;
		await addSubscription(account, { id: subscriptionId, paidThrough: 1, status: 'canceled' });
		const { invoiceId } = proInvoiceApi(account, { subscriptionId });
		await webhook(paidInvoice(invoiceId));
		expect(
			await env.DB.prepare('SELECT status, paid_through FROM subscriptions WHERE id = ?')
				.bind(subscriptionId)
				.first()
		).toEqual({ status: 'canceled', paid_through: 1 });
	});

	it('sends the buyer to Stripe Checkout with the account and the way back', async () => {
		const { cookie } = await signIn('buyer@example.com');
		const stripe = vi
			.spyOn(globalThis, 'fetch')
			// 応答は呼ばれた要求の中で作る (ほかの要求で作った本文は読めない)。
			.mockImplementation(async () =>
				Response.json({ id: 'cs_1', url: 'https://checkout.stripe.test/c/pay/cs_1' })
			);
		const res = await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('https://checkout.stripe.test/c/pay/cs_1');
		const [url, init] = stripe.mock.calls[0];
		expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
		const sent = new URLSearchParams(String(init!.body));
		expect(sent.get('client_reference_id')).toBe(await accountId('buyer@example.com'));
		expect(sent.get('customer_email')).toBe('buyer@example.com');
		expect(sent.get('subscription_data[metadata][buyer_country]')).toBe('JP');
		expect(sent.get('managed_payments[enabled]')).toBe('false');
		expect(sent.get('locale')).toBe('ja');
		expect(sent.get('success_url')).toBe(`${ORIGIN}/account/buy/done?next=%2Faccount%2F&lang=ja`);
		expect(sent.get('cancel_url')).toBe(`${ORIGIN}/account/buy?plan=monthly&lang=ja`);
		expect(new Headers(init!.headers).get('idempotency-key')).toMatch(/^mawok-pro-checkout-/);
	});

	it('shows the final confirmation before payment, and sends a request without a plan to pricing', async () => {
		const { cookie } = await signIn('offer@example.com');
		const home = await (await request('/account/', { cookie })).text();
		expect(home).toContain('href="/pricing/"');
		expect(home).not.toContain('action="/account/buy"');
		const noPlan = await request('/account/buy', { cookie, redirect: 'manual' });
		expect(noPlan.status).toBe(303);
		expect(noPlan.headers.get('location')).toBe('/pricing/');
		const confirmation = await (await request('/account/buy?plan=yearly', { cookie })).text();
		expect(confirmation).toContain('href="https://amiiby.com/tokushoho/"');
		expect(confirmation).toContain('href="/pricing/#conditions"');
		expect(confirmation).toContain('action="/account/buy"');
	});

	it('shows Link refund policy on the overseas final confirmation', async () => {
		const { cookie } = await signIn('offer-abroad@example.com');
		const confirmation = await (
			await request('/account/buy?plan=monthly', { cookie, country: 'US' })
		).text();
		expect(confirmation).toContain('Sold through Link, LLC');
		expect(confirmation).toContain('href="https://support.link.com/');
	});

	it('sells through Managed Payments to buyers outside Japan', async () => {
		const { cookie } = await signIn('abroad@example.com');
		const stripe = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () =>
				Response.json({ id: 'cs_abroad', url: 'https://checkout.stripe.test/abroad' })
			);
		const res = await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie, {
			country: 'US'
		});
		expect(res.status).toBe(303);
		const sent = new URLSearchParams(String(stripe.mock.calls[0][1]!.body));
		expect(sent.get('managed_payments[enabled]')).toBe('true');
		expect(sent.get('subscription_data[metadata][buyer_country]')).toBe('US');
		// 支払いの画面の文言は MP が決めるので、送らない。
		expect(sent.has('custom_text[submit][message]')).toBe(false);
	});

	it('sends back to the open checkout instead of opening another', async () => {
		const { cookie } = await signIn('twice@example.com');
		let n = 0;
		const stripe = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			n += 1;
			return Response.json({ id: `cs_twice${n}`, url: `https://checkout.stripe.test/${n}` });
		});
		const first = await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie);
		const second = await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie);
		expect(second.headers.get('location')).toBe(first.headers.get('location'));
		expect(stripe).toHaveBeenCalledTimes(1);
		const sent = new URLSearchParams(String(stripe.mock.calls[0][1]!.body));
		expect(Number(sent.get('expires_at')) - Date.now() / 1000).toBeGreaterThanOrEqual(1790);
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
		const busy = await postForm(
			'/account/buy',
			{ next: '/account/link?code=ABCDEF', plan: 'monthly' },
			cookie
		);
		expect(busy.status).toBe(409);
		reply = () => Response.json({ id: 'cs_race', url: 'https://checkout.stripe.test/race' });
		// 押し直しは、戻り先やアクセス元の国が違っても最初の予約と同じ頼みにする (Stripe は中身の違う頼み直しを断る)。
		const again = await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie, {
			country: 'US'
		});
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
		expect(
			(await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie)).status
		).toBe(500);
		reply = () => Response.json({ id: 'cs_fail', url: 'https://checkout.stripe.test/fail' });
		const again = await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie);
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
		expect(
			(await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie)).status
		).toBe(500);
		reply = () => Response.json({ id: 'cs_lost', url: 'https://checkout.stripe.test/lost' });
		const again = await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie);
		expect(again.headers.get('location')).toBe('https://checkout.stripe.test/lost');
		expect(keys[1]).toBe(keys[0]);
	});

	it('goes on once Pro is active, and keeps checking until then', async () => {
		const { cookie } = await signIn('back@example.com');
		const account = await accountId('back@example.com');
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			Response.json({ id: 'cs_back', url: 'https://checkout.stripe.test/back' })
		);
		await postForm('/account/buy', { next: '/account/', plan: 'monthly' }, cookie);
		const path = '/account/buy/done?next=%2Faccount%2F';
		const waiting = await request(path, { cookie });
		expect(waiting.status).toBe(200);
		expect(await waiting.text()).toContain('http-equiv="refresh"');
		const gaveUp = await (await request(`${path}&tries=10`, { cookie })).text();
		expect(gaveUp).not.toContain('http-equiv="refresh"');
		expect(gaveUp).toContain('tries=11');
		await addSubscription(account, { id: 'sub_back' });
		const done = await request(path, { cookie, redirect: 'manual' });
		expect(done.status).toBe(303);
		expect(done.headers.get('location')).toBe('/account/');
		// 次の申し込みで、払い終えた支払いの画面へ送らないよう、予約を外す。
		expect(
			await env.DB.prepare('SELECT 1 FROM checkouts WHERE account_id = ?').bind(account).first()
		).toBeNull();
	});

	it('waits on the Pro page after a Pro checkout, and stops reloading in the end', async () => {
		const { cookie } = await signIn('waiting-title@example.com');
		const path = '/account/buy/done?next=%2Faccount%2F';
		const waiting = await (await request(path, { cookie })).text();
		expect(waiting).toContain('<h1>Mawok Pro</h1>');
		expect(waiting).toContain('http-equiv="refresh"');
		const gaveUp = await (await request(`${path}&tries=10`, { cookie })).text();
		expect(gaveUp).not.toContain('http-equiv="refresh"');
	});
});
