import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import {
	confirmProInvoice,
	createProCheckoutSession,
	expireCheckoutSession,
	PRO_TRIAL_DAYS,
	ProInvoiceError,
	StripeError,
	stripeConfig,
	usesManagedPayments,
	verifyWebhook
} from '../src/stripe';
import { stripeSignature } from './helpers';

const config = stripeConfig(env)!;

describe('usesManagedPayments', () => {
	it('sells directly only to buyers in Japan', () => {
		expect(usesManagedPayments('JP')).toBe(false);
		expect(usesManagedPayments('US')).toBe(true);
		// 国が分からなければ MP にする (MP は日本の買い手にも売れる)。
		expect(usesManagedPayments(undefined)).toBe(true);
	});
});

describe('createProCheckoutSession', () => {
	function checkout(overrides: Partial<Parameters<typeof createProCheckoutSession>[1]> = {}) {
		return createProCheckoutSession(config, {
			accountId: 'acc',
			email: 'buyer@example.com',
			plan: 'monthly',
			lang: 'ja',
			successUrl: 'https://account.test/done',
			cancelUrl: 'https://account.test/cancel',
			expiresAt: 2_000_000_000,
			submitMessage: '解約するまで自動で更新します。',
			managedPayments: false,
			buyerCountry: 'JP',
			trial: true,
			idempotencyKey: 'pro-key',
			...overrides
		});
	}

	function stripeAnswers() {
		return vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () =>
				Response.json({ id: 'cs_pro', url: 'https://checkout.stripe.test/c/pay/cs_pro' })
			);
	}

	const DOMESTIC_ONLY = {
		'payment_method_types[0]': 'card',
		'line_items[0][tax_rates][0]': env.STRIPE_TAX_RATE_ID,
		'custom_text[submit][message]': '解約するまで自動で更新します。'
	};

	it('creates a subscription with the first 14-day trial and its account metadata', async () => {
		const stripe = stripeAnswers();
		expect(await checkout()).toMatchObject({ url: 'https://checkout.stripe.test/c/pay/cs_pro' });
		const [url, init] = stripe.mock.calls[0];
		expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
		expect(new Headers(init!.headers).get('idempotency-key')).toBe('pro-key');
		const sent = Object.fromEntries(new URLSearchParams(String(init!.body)));
		expect(sent).toEqual({
			mode: 'subscription',
			'line_items[0][price]': 'price_pro_monthly',
			'line_items[0][quantity]': '1',
			client_reference_id: 'acc',
			customer_email: 'buyer@example.com',
			'metadata[product]': 'mawok-pro',
			'subscription_data[metadata][product]': 'mawok-pro',
			'subscription_data[metadata][account_id]': 'acc',
			'subscription_data[metadata][managed_payments]': '0',
			'subscription_data[metadata][buyer_country]': 'JP',
			'subscription_data[trial_period_days]': String(PRO_TRIAL_DAYS),
			locale: 'ja',
			success_url: 'https://account.test/done',
			cancel_url: 'https://account.test/cancel',
			expires_at: '2000000000',
			'managed_payments[enabled]': 'false',
			...DOMESTIC_ONLY
		});
	});

	it('gives no trial to an account that has had one, and uses the yearly price', async () => {
		const stripe = stripeAnswers();
		await checkout({ plan: 'yearly', trial: false });
		const sent = new URLSearchParams(String(stripe.mock.calls[0][1]!.body));
		expect(sent.get('line_items[0][price]')).toBe('price_pro_yearly');
		expect(sent.has('subscription_data[trial_period_days]')).toBe(false);
	});

	it('leaves payment methods, tax and the checkout note to Managed Payments', async () => {
		const stripe = stripeAnswers();
		await checkout({ managedPayments: true, submitMessage: undefined, buyerCountry: 'US' });
		const sent = new URLSearchParams(String(stripe.mock.calls[0][1]!.body));
		expect(sent.get('managed_payments[enabled]')).toBe('true');
		expect(sent.get('subscription_data[metadata][managed_payments]')).toBe('1');
		expect(sent.get('subscription_data[metadata][buyer_country]')).toBe('US');
		// 送ると Stripe に断られる。
		for (const key of Object.keys(DOMESTIC_ONLY)) expect(sent.has(key), key).toBe(false);
	});

	it('lets a relay address enter the email on Stripe Checkout', async () => {
		for (const email of ['buyer123@privaterelay.appleid.com', 'buyer456@private.icloud.com']) {
			const stripe = stripeAnswers();
			await checkout({ email });
			const sent = new URLSearchParams(String(stripe.mock.calls[0][1]!.body));
			expect(sent.has('customer_email'), email).toBe(false);
			vi.restoreAllMocks();
		}
	});

	it('tells the status Stripe answered with', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async () => new Response('{"error":{"type":"idempotency_error"}}', { status: 409 })
		);
		await expect(checkout()).rejects.toSatisfy((e) => e instanceof StripeError && e.status === 409);
	});
});

describe('expireCheckoutSession', () => {
	it('leaves the caller free to replace a session Stripe cannot close', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		for (const answer of [
			async () => new Response('', { status: 400 }),
			async () => new Response('', { status: 404 }),
			async () => new Response('', { status: 500 }),
			async () => {
				throw new TypeError('network failure');
			}
		]) {
			const stripe = vi.spyOn(globalThis, 'fetch').mockImplementation(answer);
			await expect(expireCheckoutSession(config, 'cs_old')).resolves.toBeUndefined();
			stripe.mockRestore();
		}
		expect(logged).toHaveBeenCalledTimes(2);
		logged.mockRestore();
	});
});

describe('confirmProInvoice', () => {
	function proInvoice(overrides: Record<string, unknown> = {}) {
		const invoice = {
			id: 'in_pro',
			status: 'paid',
			total: 480,
			amount_paid: 480,
			currency: 'jpy',
			customer_details: { address: { country: 'JP' } },
			parent: { subscription_details: { subscription: 'sub_pro' } },
			lines: {
				has_more: false,
				data: [
					{
						amount: 480,
						currency: 'jpy',
						quantity: 1,
						period: { end: 2_000_000_000 },
						pricing: { price_details: { price: 'price_pro_monthly' } },
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
							payment_intent: { id: 'pi_pro', latest_charge: 'ch_pro' }
						}
					}
				]
			},
			...overrides
		};
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			const path = new URL(String(url)).pathname;
			if (path.endsWith('/invoices/in_pro')) return Response.json(invoice);
			if (path.endsWith('/subscriptions/sub_pro'))
				return Response.json({
					id: 'sub_pro',
					status: 'active',
					customer: 'cus_pro',
					metadata: { product: 'mawok-pro', managed_payments: '0', buyer_country: 'US' },
					items: {
						data: [
							{
								current_period_end: 2_000_000_000,
								price: { id: 'price_pro_monthly', currency: 'jpy' }
							}
						]
					}
				});
			if (path.endsWith('/charges/ch_pro'))
				return Response.json({ payment_method_details: { card: { country: 'US' } } });
			throw new Error(`Unexpected Stripe request: ${path}`);
		});
	}

	it('confirms every invoice field before recording a Pro payment', async () => {
		proInvoice();
		expect(await confirmProInvoice(config, 'in_pro')).toMatchObject({
			plan: 'monthly',
			amount: 480,
			currency: 'jpy',
			paymentIntentId: 'pi_pro',
			cardCountry: 'US',
			buyerCountry: 'US',
			domestic: true
		});
		vi.restoreAllMocks();
		proInvoice({ customer_details: { address: null } });
		expect((await confirmProInvoice(config, 'in_pro'))?.domestic).toBe(false);
		for (const overrides of [
			{ amount_paid: 479 },
			{ lines: { has_more: true, data: [] } },
			{
				payments: {
					has_more: false,
					data: [{ status: 'paid', amount_paid: 480, payment: { type: 'bank_transfer' } }]
				}
			}
		]) {
			vi.restoreAllMocks();
			proInvoice(overrides);
			await expect(
				confirmProInvoice(config, 'in_pro'),
				JSON.stringify(overrides)
			).rejects.toBeInstanceOf(ProInvoiceError);
		}
	});

	it('accepts the zero-yen trial invoice without recording a payment intent', async () => {
		proInvoice({
			total: 0,
			amount_paid: 0,
			lines: {
				has_more: false,
				data: [
					{
						amount: 0,
						currency: 'jpy',
						quantity: 1,
						period: { end: 2_000_000_000 },
						pricing: { price_details: { price: 'price_pro_monthly' } },
						discount_amounts: []
					}
				]
			},
			payments: { has_more: false, data: [] }
		});
		expect(await confirmProInvoice(config, 'in_pro')).toMatchObject({
			amount: 0,
			paymentIntentId: null
		});
	});
});

describe('verifyWebhook', () => {
	const body = '{"id":"evt_1"}';
	const now = 1_800_000_000;

	it('accepts a signature made with the secret within five minutes', async () => {
		expect(
			await verifyWebhook(config, body, await stripeSignature(body, 'whsec_test', now), now)
		).toBe(true);
		expect(
			await verifyWebhook(config, body, await stripeSignature(body, 'whsec_test', now - 300), now)
		).toBe(true);
		// 秘密を替える間は、古い秘密と新しい秘密の署名が並んで届く。
		const rolled = `${await stripeSignature(body, 'whsec_old', now)},v1=${
			(await stripeSignature(body, 'whsec_test', now)).split('v1=')[1]
		}`;
		expect(await verifyWebhook(config, body, rolled, now)).toBe(true);
	});

	it('rejects a wrong, stale, tampered or missing signature', async () => {
		const cases: [string, string | undefined, string][] = [
			['wrong secret', await stripeSignature(body, 'whsec_wrong', now), body],
			['stale', await stripeSignature(body, 'whsec_test', now - 301), body],
			['tampered body', await stripeSignature(body, 'whsec_test', now), '{"id":"evt_2"}'],
			['not hex', `t=${now},v1=zz`, body],
			['no v1', `t=${now}`, body],
			['missing', undefined, body]
		];
		for (const [name, header, received] of cases) {
			expect(await verifyWebhook(config, received, header, now), name).toBe(false);
		}
	});
});
