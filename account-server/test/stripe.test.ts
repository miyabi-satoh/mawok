import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import {
	confirmPurchase,
	createProCheckoutSession,
	createCheckoutSession,
	StripeError,
	stripeConfig,
	usesManagedPayments,
	verifyWebhook
} from '../src/stripe';
import { stripeSessions, stripeSignature } from './helpers';

const config = stripeConfig(env)!;

describe('usesManagedPayments', () => {
	it('sells directly only to buyers in Japan', () => {
		expect(usesManagedPayments('JP')).toBe(false);
		expect(usesManagedPayments('US')).toBe(true);
		// 国が分からなければ MP にする (MP は日本の買い手にも売れる)。
		expect(usesManagedPayments(undefined)).toBe(true);
	});
});

describe('createCheckoutSession', () => {
	function checkout(overrides: Partial<Parameters<typeof createCheckoutSession>[1]> = {}) {
		return createCheckoutSession(config, {
			accountId: 'acc',
			email: 'buyer@example.com',
			lang: 'ja',
			successUrl: 'https://account.test/done',
			cancelUrl: 'https://account.test/',
			expiresAt: 2_000_000_000,
			submitMessage: '特定商取引法に基づく表記',
			managedPayments: false,
			buyerCountry: 'JP',
			idempotencyKey: 'key-1',
			...overrides
		});
	}

	function stripeAnswers() {
		return vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () =>
				Response.json({ id: 'cs_1', url: 'https://checkout.stripe.test/c/pay/cs_1' })
			);
	}

	const DOMESTIC_ONLY = {
		'payment_method_types[0]': 'card',
		'line_items[0][tax_rates][0]': env.STRIPE_TAX_RATE_ID,
		'payment_intent_data[statement_descriptor_suffix]': 'MAWOK',
		'payment_method_options[card][statement_descriptor_suffix_kanji]': 'Mawok',
		'payment_method_options[card][statement_descriptor_suffix_kana]': 'マオック',
		'custom_text[submit][message]': '特定商取引法に基づく表記'
	};

	it('sells in Japan by card, with the tax rate and the statement descriptor', async () => {
		const stripe = stripeAnswers();
		expect(await checkout()).toMatchObject({ url: 'https://checkout.stripe.test/c/pay/cs_1' });
		const [url, init] = stripe.mock.calls[0];
		expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
		expect(new Headers(init!.headers).get('idempotency-key')).toBe('key-1');
		const sent = Object.fromEntries(new URLSearchParams(String(init!.body)));
		expect(sent).toEqual({
			mode: 'payment',
			'line_items[0][price]': 'price_credits',
			'line_items[0][quantity]': '1',
			client_reference_id: 'acc',
			customer_email: 'buyer@example.com',
			'metadata[product]': 'mawok-ai',
			'metadata[buyer_country]': 'JP',
			locale: 'ja',
			success_url: 'https://account.test/done',
			cancel_url: 'https://account.test/',
			expires_at: '2000000000',
			'managed_payments[enabled]': 'false',
			...DOMESTIC_ONLY
		});
	});

	it('leaves payment methods, tax and the descriptor to Managed Payments', async () => {
		const stripe = stripeAnswers();
		await checkout({ managedPayments: true, submitMessage: undefined, buyerCountry: 'US' });
		const sent = new URLSearchParams(String(stripe.mock.calls[0][1]!.body));
		expect(sent.get('managed_payments[enabled]')).toBe('true');
		expect(sent.get('metadata[buyer_country]')).toBe('US');
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

describe('createProCheckoutSession', () => {
	it('creates a subscription with the first 14-day trial and its account metadata', async () => {
		const stripe = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () =>
				Response.json({ id: 'cs_pro', url: 'https://checkout.stripe.test/c/pay/cs_pro' })
			);
		await createProCheckoutSession(
			{ ...config, proPrices: { monthly: 'price_pro_monthly', yearly: 'price_pro_yearly' } },
			{
				accountId: 'acc',
				email: 'buyer@example.com',
				plan: 'monthly',
				lang: 'ja',
				successUrl: 'https://account.test/done',
				cancelUrl: 'https://account.test/cancel',
				expiresAt: 2_000_000_000,
				managedPayments: false,
				trial: true,
				idempotencyKey: 'pro-key'
			}
		);
		const sent = new URLSearchParams(String(stripe.mock.calls[0][1]!.body));
		expect(sent.get('mode')).toBe('subscription');
		expect(sent.get('line_items[0][price]')).toBe('price_pro_monthly');
		expect(sent.get('subscription_data[trial_period_days]')).toBe('14');
		expect(sent.get('subscription_data[metadata][product]')).toBe('mawok-pro');
		expect(sent.get('subscription_data[metadata][account_id]')).toBe('acc');
	});
});

describe('confirmPurchase', () => {
	const charge = (country: string | null) => ({
		id: `pi_${crypto.randomUUID()}`,
		latest_charge: { payment_method_details: { card: { country } } }
	});

	it('returns what to record for a paid checkout of the credits price', async () => {
		const stripe = stripeSessions('acc');
		expect(await confirmPurchase(config, 'cs_paid')).toEqual({
			sessionId: 'cs_paid',
			accountId: 'acc',
			paymentIntentId: 'pi_cs_paid',
			amount: 300,
			currency: 'jpy',
			managedPayments: false,
			cardCountry: 'JP',
			buyerCountry: 'JP',
			domestic: true
		});
		expect(String(stripe.mock.calls[0][0])).toContain('/v1/checkout/sessions/cs_paid?');
	});

	it('records a Managed Payments sale without a card', async () => {
		stripeSessions('acc', {
			managed_payments: { enabled: true },
			metadata: { product: 'mawok-ai', buyer_country: 'US' },
			payment_intent: { id: 'pi_mp', latest_charge: { payment_method_details: {} } }
		});
		expect(await confirmPurchase(config, 'cs_mp')).toMatchObject({
			managedPayments: true,
			cardCountry: null,
			buyerCountry: 'US',
			domestic: false
		});
	});

	it('decides whether the sale is domestic by the address, then the card, then the access', async () => {
		for (const [name, overrides, domestic] of [
			// MP をすり抜けた日本の買い手 (住所が日本) は国内。
			[
				'address',
				{
					customer_details: { address: { country: 'JP' } },
					payment_intent: charge('US'),
					metadata: { product: 'mawok-ai', buyer_country: 'US' }
				},
				true
			],
			['card', { customer_details: { address: null }, payment_intent: charge('US') }, false],
			['access', { customer_details: null, payment_intent: charge(null) }, true]
		] as const) {
			vi.restoreAllMocks();
			stripeSessions('acc', overrides);
			expect((await confirmPurchase(config, `cs_${name}`))?.domestic, name).toBe(domestic);
		}
	});

	it('does not trust the notice: confirms only a paid checkout of one credits price', async () => {
		for (const overrides of [
			{ payment_status: 'unpaid' },
			{ amount_total: 1 },
			{ amount_total: null },
			{ currency: 'usd' },
			{ metadata: { product: 'bp-carnet' } },
			{ client_reference_id: null },
			{ payment_intent: null },
			{
				line_items: {
					data: [{ quantity: 2, price: { id: 'price_credits', unit_amount: 300, currency: 'jpy' } }]
				}
			},
			{
				line_items: {
					data: [{ quantity: 1, price: { id: 'price_other', unit_amount: 300, currency: 'jpy' } }]
				}
			}
		]) {
			vi.restoreAllMocks();
			// 払われたのに付けられない支払いは、手で調べられるようログに残す。
			vi.spyOn(console, 'error').mockImplementation(() => {});
			stripeSessions('acc', overrides);
			expect(await confirmPurchase(config, 'cs_forged'), JSON.stringify(overrides)).toBeUndefined();
		}
	});

	it('throws when Stripe cannot answer, so the notice is sent again', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async () => new Response('{"error":{"type":"api_error"}}', { status: 500 })
		);
		await expect(confirmPurchase(config, 'cs_retry')).rejects.toBeInstanceOf(StripeError);
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
