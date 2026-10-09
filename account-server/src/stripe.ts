/**
 * Stripe での AI の残高の販売 (→ docs/account-server.md「購入」)。
 * SDK は使わず、要る3つ (Checkout Session を作る・取り直す・webhook の署名を確かめる) だけを fetch と Web Crypto で書く。
 */

/** 送られてから受け付けるまでの猶予。古い webhook を送り直されても通さないように (Stripe の SDK の既定と同じ)。 */
const WEBHOOK_TOLERANCE = 300;

/** 同じ Stripe のアカウントで売るほかの製品の webhook と見分ける印。Checkout Session の metadata に付ける。 */
export const PRODUCT = 'mawok-ai';

/** Stripe が断った頼み。`status` が 409 なら、同じ Idempotency-Key の頼みを Stripe が処理している最中。 */
export class StripeError extends Error {
	constructor(
		readonly status: number,
		body: string
	) {
		super(`Stripe responded ${status}: ${body}`);
	}
}

export type StripeConfig = {
	secretKey: string;
	webhookSecret: string;
	creditsPriceId: string;
	taxRateId: string;
	proPrices?: Record<'monthly' | 'yearly', string>;
};

/** 秘密の値が3つと税率がそろったときだけ売る。手元で動かすときは無くてよい。 */
export function stripeConfig(env: Env): StripeConfig | undefined {
	const {
		STRIPE_SECRET_KEY,
		STRIPE_WEBHOOK_SECRET,
		STRIPE_AI_CREDITS_PRICE_ID,
		STRIPE_TAX_RATE_ID
	} = env;
	if (
		!STRIPE_SECRET_KEY ||
		!STRIPE_WEBHOOK_SECRET ||
		!STRIPE_AI_CREDITS_PRICE_ID ||
		!STRIPE_TAX_RATE_ID
	) {
		return undefined;
	}
	return {
		secretKey: STRIPE_SECRET_KEY,
		webhookSecret: STRIPE_WEBHOOK_SECRET,
		creditsPriceId: STRIPE_AI_CREDITS_PRICE_ID,
		taxRateId: STRIPE_TAX_RATE_ID,
		proPrices:
			env.STRIPE_PRO_MONTHLY_PRICE_ID && env.STRIPE_PRO_YEARLY_PRICE_ID
				? { monthly: env.STRIPE_PRO_MONTHLY_PRICE_ID, yearly: env.STRIPE_PRO_YEARLY_PRICE_ID }
				: undefined
	};
}

/** 月額と年額の Price が両方あるときだけ Pro を売る。 */
export function proForSale(
	config: StripeConfig
): config is StripeConfig & { proPrices: Record<'monthly' | 'yearly', string> } {
	return config.proPrices !== undefined;
}

/**
 * 日本からの買い手には直接、ほかの国からの買い手には Managed Payments で売る。
 * 国はアクセス元の IP で決める。分からなければ MP にする (MP は日本の買い手にも売れる)。
 */
export function usesManagedPayments(country: string | undefined): boolean {
	return country !== 'JP';
}

/**
 * Sign in with Apple の転送用アドレスのドメイン。2026 年の後半から新しいアドレスは private.icloud.com で出て、
 * 前からのアドレスも使い続けられる (Apple Developer News「Update: New domain for Sign in with Apple」2026-08-24)。
 */
const APPLE_RELAY_DOMAINS = ['privaterelay.appleid.com', 'private.icloud.com'];

/** 明細に出す、この製品の表記 (アカウントの接頭辞に続く)。英字とカナは10文字、漢字は9文字まで。 */
const STATEMENT_SUFFIX = { latin: 'MAWOK', kanji: 'Mawok', kana: 'マオック' };

/**
 * 残高を買う Checkout Session を作る。`expiresAt` (UNIX 秒) は Stripe の決まりで30分以上先。
 * 同じ `idempotencyKey` で頼み直すと、Stripe は最初に作った Session を返す (24時間まで)。
 */
export async function createCheckoutSession(
	config: StripeConfig,
	{
		accountId,
		email,
		lang,
		successUrl,
		cancelUrl,
		expiresAt,
		submitMessage,
		managedPayments,
		buyerCountry,
		idempotencyKey
	}: {
		accountId: string;
		email: string;
		lang: string;
		successUrl: string;
		cancelUrl: string;
		expiresAt: number;
		/** 支払いのボタンの下に出す文言。MP の Session では送れないので、国内の分だけ渡す。 */
		submitMessage?: string;
		managedPayments: boolean;
		/** 買ったときのアクセス元の国。台帳に残すだけで、振り分けのほかには使わない。 */
		buyerCountry?: string;
		idempotencyKey: string;
	}
): Promise<{ url: string }> {
	const params = new URLSearchParams({
		mode: 'payment',
		'line_items[0][price]': config.creditsPriceId,
		'line_items[0][quantity]': '1',
		client_reference_id: accountId,
		'metadata[product]': PRODUCT,
		locale: lang,
		success_url: successUrl,
		cancel_url: cancelUrl,
		expires_at: String(expiresAt),
		// 指定しないとアカウントの既定 (MP が有効) になるので、国内の分も明示する。
		'managed_payments[enabled]': String(managedPayments)
	});
	// MP の Session では、払い方・税・明細の表記・支払いの画面の文言を Stripe が決め、指定すると断られる。
	if (!managedPayments) {
		for (const [key, value] of Object.entries({
			// カードだけにする。後から払う方法 (コンビニ払いなど) は入金まで日がかかり、戻り先の画面で待ち切れない。
			'payment_method_types[0]': 'card',
			// 領収書を適格簡易請求書にするための、税率と税額 (税込み 10%)。
			'line_items[0][tax_rates][0]': config.taxRateId,
			'payment_intent_data[statement_descriptor_suffix]': STATEMENT_SUFFIX.latin,
			'payment_method_options[card][statement_descriptor_suffix_kanji]': STATEMENT_SUFFIX.kanji,
			'payment_method_options[card][statement_descriptor_suffix_kana]': STATEMENT_SUFFIX.kana
		})) {
			params.set(key, value);
		}
	}
	if (buyerCountry) params.set('metadata[buyer_country]', buyerCountry);
	// Checkout は渡したメールを直させない。Apple の転送用アドレスには、登録していない Stripe からの領収書が届かないので、
	// 渡さずに支払いの画面で入れてもらう。
	if (!APPLE_RELAY_DOMAINS.some((domain) => email.endsWith(`@${domain}`))) {
		params.set('customer_email', email);
	}
	// 特定商取引法 12条の6 の最終確認画面に要る、引き渡しと返金の扱い。Markdown のリンクを書ける。
	// MP の分は、同じ事項を買う画面 (→ src/pages.ts の confirmPage) にだけ出す。
	if (submitMessage) params.set('custom_text[submit][message]', submitMessage);
	const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${config.secretKey}`,
			'idempotency-key': idempotencyKey
		},
		body: params
	});
	if (!res.ok) throw new StripeError(res.status, await res.text());
	return res.json<{ url: string }>();
}

/** Pro の Checkout Session。試用を受けたことがあるアカウントには試用を渡さない。 */
export async function createProCheckoutSession(
	config: StripeConfig & { proPrices: Record<'monthly' | 'yearly', string> },
	{
		accountId,
		email,
		plan,
		lang,
		successUrl,
		cancelUrl,
		expiresAt,
		submitMessage,
		managedPayments,
		buyerCountry,
		trial,
		idempotencyKey
	}: {
		accountId: string;
		email: string;
		plan: 'monthly' | 'yearly';
		lang: string;
		successUrl: string;
		cancelUrl: string;
		expiresAt: number;
		submitMessage?: string;
		managedPayments: boolean;
		/** Checkout を開いたときのアクセス元の国。請求書の台帳へ残す。 */
		buyerCountry?: string;
		trial: boolean;
		idempotencyKey: string;
	}
): Promise<{ id: string; url: string }> {
	const params = new URLSearchParams({
		mode: 'subscription',
		'line_items[0][price]': config.proPrices[plan],
		'line_items[0][quantity]': '1',
		client_reference_id: accountId,
		'metadata[product]': 'mawok-pro',
		'subscription_data[metadata][product]': 'mawok-pro',
		'subscription_data[metadata][account_id]': accountId,
		'subscription_data[metadata][managed_payments]': managedPayments ? '1' : '0',
		locale: lang,
		success_url: successUrl,
		cancel_url: cancelUrl,
		expires_at: String(expiresAt),
		'managed_payments[enabled]': String(managedPayments)
	});
	if (buyerCountry) params.set('subscription_data[metadata][buyer_country]', buyerCountry);
	if (trial) params.set('subscription_data[trial_period_days]', '14');
	if (!managedPayments) {
		params.set('payment_method_types[0]', 'card');
		params.set('line_items[0][tax_rates][0]', config.taxRateId);
	}
	if (!APPLE_RELAY_DOMAINS.some((domain) => email.endsWith(`@${domain}`)))
		params.set('customer_email', email);
	if (submitMessage) params.set('custom_text[submit][message]', submitMessage);
	const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
		method: 'POST',
		headers: { authorization: `Bearer ${config.secretKey}`, 'idempotency-key': idempotencyKey },
		body: params
	});
	if (!res.ok) throw new StripeError(res.status, await res.text());
	return res.json<{ id: string; url: string }>();
}

type StripeSubscription = {
	id: string;
	status: string;
	customer: string;
	metadata: Record<string, string> | null;
	items: {
		data: { current_period_end: number; price: { id: string; currency?: string | null } }[];
	};
};

async function stripeGet<T>(
	config: StripeConfig,
	path: string,
	query?: URLSearchParams
): Promise<T> {
	const res = await fetch(`https://api.stripe.com/v1/${path}${query ? `?${query}` : ''}`, {
		headers: { authorization: `Bearer ${config.secretKey}` }
	});
	if (!res.ok) throw new StripeError(res.status, await res.text());
	return res.json<T>();
}

export function getSubscription(config: StripeConfig, id: string) {
	return stripeGet<StripeSubscription>(config, `subscriptions/${encodeURIComponent(id)}`);
}

/** 0 円の試用開始請求書も含め、Pro の請求書を取り直して確かめる。 */
export async function confirmProInvoice(
	config: StripeConfig & { proPrices: Record<'monthly' | 'yearly', string> },
	invoiceId: string
) {
	const invoice = await stripeGet<{
		id: string;
		status: string;
		total: number;
		amount_paid: number;
		currency: string;
		customer_details: { address: { country: string | null } | null } | null;
		parent: { subscription_details?: { subscription: string } | null } | null;
		lines: {
			has_more: boolean;
			data: {
				amount: number;
				currency: string;
				quantity: number | null;
				period: { end: number };
				pricing: { price_details?: { price: string } } | null;
				discount_amounts: { amount: number }[];
			}[];
		};
		payments: {
			has_more: boolean;
			data: {
				status: string;
				amount_paid: number | null;
				payment: {
					type: string;
					payment_intent?: { id: string; latest_charge: string | null };
				};
			}[];
		};
	}>(
		config,
		`invoices/${encodeURIComponent(invoiceId)}`,
		new URLSearchParams([
			['expand[]', 'payments.data.payment.payment_intent'],
			['expand[]', 'parent.subscription_details']
		])
	);
	const subscriptionId = invoice.parent?.subscription_details?.subscription;
	if (invoice.status !== 'paid' || !subscriptionId) return undefined;
	const sub = await getSubscription(config, subscriptionId);
	if (sub.metadata?.product !== 'mawok-pro') return undefined;
	const lines = invoice.lines.data;
	// 試用開始の 0 円請求書も、通常の請求書と同じ Price の1項目として確かめる。
	const charged = invoice.total === 0 ? lines : lines.filter((line) => line.amount > 0);
	const line = charged[0];
	const priceId = line?.pricing?.price_details?.price;
	if (!line || !priceId || sub.items.data.length !== 1) return undefined;
	const plan =
		priceId === config.proPrices.monthly
			? 'monthly'
			: priceId === config.proPrices.yearly
				? 'yearly'
				: undefined;
	if (!plan) return undefined;
	const paid = invoice.payments.data.filter((payment) => payment.status === 'paid');
	const intent = paid[0]?.payment.payment_intent;
	const zeroInvoice = invoice.total === 0;
	if (
		invoice.lines.has_more ||
		charged.length !== 1 ||
		lines.length !== 1 ||
		lines.some(
			(item) =>
				item.quantity !== 1 ||
				item.currency !== invoice.currency ||
				item.discount_amounts.some((discount) => discount.amount !== 0) ||
				item.pricing?.price_details?.price !== priceId
		) ||
		sub.items.data[0].price.id !== priceId ||
		(sub.items.data[0].price.currency !== undefined &&
			sub.items.data[0].price.currency !== null &&
			sub.items.data[0].price.currency !== invoice.currency) ||
		lines.reduce((sum, item) => sum + item.amount, 0) !== invoice.total ||
		invoice.amount_paid !== invoice.total ||
		invoice.payments.has_more ||
		(zeroInvoice
			? paid.length > 1 || paid.some((payment) => payment.amount_paid !== 0)
			: paid.length !== 1 ||
				paid[0].payment.type !== 'payment_intent' ||
				!intent ||
				paid[0].amount_paid !== invoice.total)
	) {
		return undefined;
	}
	const charge = intent?.latest_charge
		? await stripeGet<{ payment_method_details: { card?: { country: string | null } } | null }>(
				config,
				`charges/${encodeURIComponent(intent.latest_charge)}`
			)
		: null;
	const cardCountry = charge?.payment_method_details?.card?.country ?? null;
	const buyerCountry = sub.metadata?.buyer_country ?? null;
	const country = invoice.customer_details?.address?.country || cardCountry || buyerCountry;
	return {
		invoiceId: invoice.id,
		subscription: sub,
		plan,
		periodEnd: line.period.end,
		amount: invoice.total,
		currency: invoice.currency,
		paymentIntentId: intent?.id ?? null,
		managedPayments: sub.metadata?.managed_payments === '1',
		cardCountry,
		buyerCountry,
		domestic: country === 'JP'
	};
}

export async function cancelSubscription(config: StripeConfig, id: string) {
	const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, {
		method: 'DELETE',
		headers: { authorization: `Bearer ${config.secretKey}` }
	});
	if (!res.ok && res.status !== 404 && res.status !== 400)
		throw new StripeError(res.status, await res.text());
}

export async function billingPortalUrl(
	config: StripeConfig,
	customer: string,
	returnUrl: string,
	lang: string
) {
	const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
		method: 'POST',
		headers: { authorization: `Bearer ${config.secretKey}` },
		body: new URLSearchParams({ customer, return_url: returnUrl, locale: lang })
	});
	if (!res.ok) throw new StripeError(res.status, await res.text());
	return (await res.json<{ url: string }>()).url;
}

/** 付けてよいと確かめた支払い。台帳に残す。 */
type Purchase = {
	sessionId: string;
	accountId: string;
	paymentIntentId: string;
	/** 払われた額と通貨 (Price のもの。最小の単位で、円ならそのまま)。 */
	amount: number;
	currency: string;
	managedPayments: boolean;
	/** カードで払ったときの発行国。振り分けや返金には使わない。 */
	cardCountry: string | null;
	/** 買ったときのアクセス元の国。 */
	buyerCountry: string | null;
	/**
	 * 国内の取引か。消費税の課税売上を数えるのに使い、アカウントを消しても残す。
	 * 国は、買い手の住所の国、無ければカードの発行国で見る。どちらも無ければ、アクセス元の国で見る。
	 */
	domestic: boolean;
};

type CheckoutSession = {
	id: string;
	client_reference_id: string | null;
	payment_status: string;
	currency: string;
	amount_total: number | null;
	metadata: Record<string, string> | null;
	managed_payments: { enabled: boolean } | null;
	customer_details: { address: { country: string | null } | null } | null;
	line_items: {
		data: {
			quantity: number | null;
			price: { id: string; unit_amount: number | null; currency: string } | null;
		}[];
	};
	payment_intent: {
		id: string;
		latest_charge: { payment_method_details: { card?: { country: string | null } } | null } | null;
	} | null;
};

/**
 * 知らせの本文は信じず、Checkout Session を Stripe から取り直して、付けてよい支払いかを確かめる。
 * この製品のものでない・払われていない・中身が違うときは `undefined`。
 * 額は Price の額のまま (税込み) で、Adaptive Pricing で買い手の通貨で払っても Session の額と通貨は Price のまま。
 */
export async function confirmPurchase(
	config: StripeConfig,
	sessionId: string
): Promise<Purchase | undefined> {
	const query = new URLSearchParams([
		['expand[]', 'line_items'],
		['expand[]', 'payment_intent.latest_charge']
	]);
	const res = await fetch(
		`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?${query}`,
		{ headers: { authorization: `Bearer ${config.secretKey}` } }
	);
	if (!res.ok) throw new StripeError(res.status, await res.text());
	const session = await res.json<CheckoutSession>();
	if (session.metadata?.product !== PRODUCT || session.payment_status !== 'paid') return undefined;
	const items = session.line_items.data;
	const price = items[0]?.price;
	if (
		!session.client_reference_id ||
		!session.payment_intent ||
		items.length !== 1 ||
		items[0].quantity !== 1 ||
		price?.id !== config.creditsPriceId ||
		session.currency !== price.currency ||
		session.amount_total === null ||
		session.amount_total !== price.unit_amount
	) {
		// 払われたのに付けられない。Price の設定の誤りなどで起きうるので、手で調べられるよう残す (`wrangler tail`)。
		console.error('Paid checkout does not match the AI credits price', {
			session: session.id,
			currency: session.currency,
			amountTotal: session.amount_total,
			items: items.map((item) => ({ price: item.price, quantity: item.quantity }))
		});
		return undefined;
	}
	const cardCountry =
		session.payment_intent.latest_charge?.payment_method_details?.card?.country ?? null;
	const buyerCountry = session.metadata?.buyer_country ?? null;
	const country = session.customer_details?.address?.country || cardCountry || buyerCountry;
	return {
		sessionId: session.id,
		accountId: session.client_reference_id,
		paymentIntentId: session.payment_intent.id,
		amount: session.amount_total,
		currency: session.currency,
		managedPayments: session.managed_payments?.enabled === true,
		cardCountry,
		buyerCountry,
		domestic: country === 'JP'
	};
}

/**
 * `Stripe-Signature: t=<秒>,v1=<署名>[,v1=...]` を確かめる。署名は `<秒>.<本文>` の HMAC-SHA256。
 * 本文は受け取ったままのバイト列で確かめる (JSON を読み直すと並びが変わって通らない)。
 */
export async function verifyWebhook(
	config: StripeConfig,
	body: string,
	header: string | undefined,
	nowSeconds: number
): Promise<boolean> {
	const parts = (header ?? '').split(',').map((part) => part.trim().split('='));
	const timestamp = parts.find(([k]) => k === 't')?.[1];
	const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
	if (!timestamp || signatures.length === 0) return false;
	if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE) return false;
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(config.webhookSecret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify']
	);
	const signed = new TextEncoder().encode(`${timestamp}.${body}`);
	for (const signature of signatures) {
		const bytes = hexToBytes(signature);
		// 比べるのは verify に任せる (中で時間の揃った比較をする)。
		if (bytes && (await crypto.subtle.verify('HMAC', key, bytes, signed))) return true;
	}
	return false;
}

function hexToBytes(hex: string): Uint8Array | undefined {
	if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return undefined;
	return Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
}
