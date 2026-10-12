/**
 * Stripe からの知らせの処理 (→ docs/account-server.md「購入」)。入口と署名の確かめは src/index.ts。
 */
import { proUntilSql } from './credits';
import { sendMail } from './mail';
import { pricing } from './pricing';
import {
	cancelSubscription,
	confirmProInvoice,
	confirmPurchase,
	getSubscription,
	isPaidProInvoice,
	PRODUCT,
	PRO_PRODUCT,
	ProInvoiceError,
	proForSale,
	type StripeConfig
} from './stripe';
import { now, randomHex } from './util';

/**
 * アカウントを消したあと、購入の記録を残す期間。適格請求書の写しと帳簿の保存期間 (7年) に、うるう年の分を足す
 * (3つのアプリで揃える決まり)。使った分の記録も同じ期間残す。
 */
const PURCHASE_RETENTION = 7 * 366 * 24 * 60 * 60;

/**
 * 保存の期間を過ぎた記録を消す。購入の台帳は、アカウントから外れて期間を過ぎたもの (期間は外した日時から数える。
 * アカウントが無いまま届いた購入は、購入の日時から)。使った分の記録は、購入の分は台帳と一緒に消え、無料の分は日時で消す。
 * 知らせは少ないので、受けるたびに片付ける。
 */
export function forgetOldRecords(env: Env) {
	const before = now() - PURCHASE_RETENTION;
	return env.DB.batch([
		env.DB.prepare(
			`DELETE FROM purchases
			 WHERE account_id IS NULL AND coalesce(detached_at, created_at) <= ?
			   AND NOT EXISTS (SELECT 1 FROM grants WHERE purchase_id = purchases.id)`
		).bind(before),
		env.DB.prepare('DELETE FROM consumptions WHERE purchase_id IS NULL AND created_at <= ?').bind(
			before
		),
		env.DB.prepare('DELETE FROM stripe_revoked_payments WHERE created_at <= ?').bind(before)
	]);
}

export function markStripeEvent(env: Env, id: string, status: 'done' | 'failed') {
	return env.DB.prepare('UPDATE stripe_events SET status = ?, updated_at = ? WHERE id = ?')
		.bind(status, now(), id)
		.run();
}

/** 同じ Stripe のアカウントのほかの製品の知らせも届くので、metadata の印で見分け、ほかは何もしない。 */
export async function handleStripeEvent(
	env: Env,
	config: StripeConfig,
	type: string,
	object: Record<string, unknown>
): Promise<'failed' | void> {
	switch (type) {
		case 'invoice.paid': {
			if (!proForSale(config)) {
				if (await isPaidProInvoice(config, String(object.id))) {
					await reportProInvoiceProblem(
						env,
						String(object.id),
						'Pro の Price がそろっていません。'
					);
					return 'failed';
				}
				return;
			}
			let paid;
			try {
				paid = await confirmProInvoice(config, String(object.id));
			} catch (e) {
				if (!(e instanceof ProInvoiceError)) throw e;
				await reportProInvoiceProblem(env, String(object.id), e.message);
				return 'failed';
			}
			if (!paid) return;
			const accountId = paid.subscription.metadata?.account_id;
			const t = now();
			const account = accountId
				? await env.DB.prepare('SELECT id FROM accounts WHERE id = ?')
						.bind(accountId)
						.first<{ id: string }>()
				: null;
			const knownSubscription = account
				? await env.DB.prepare('SELECT 1 FROM subscriptions WHERE id = ? AND account_id = ?')
						.bind(paid.subscription.id, account.id)
						.first()
				: null;
			const revokedPayment =
				'(SELECT created_at FROM stripe_revoked_payments WHERE payment_intent_id = ?)';
			await env.DB.batch([
				env.DB.prepare(
					`INSERT INTO subscriptions (id, account_id, plan, stripe_customer_id, paid_through, status, created_at)
					 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
					 WHERE ?2 IS NOT NULL AND ?6 != 'canceled' AND ${revokedPayment.replace('?', '?8')} IS NULL
					   AND (?10 = 1 OR NOT EXISTS (
					     SELECT 1 FROM subscriptions
					     WHERE account_id = ?2 AND id != ?1 AND revoked_at IS NULL AND ${proUntilSql} > ?7
					   ))
					 ON CONFLICT (id) DO UPDATE SET plan = excluded.plan, stripe_customer_id = excluded.stripe_customer_id,
					 paid_through = max(subscriptions.paid_through, excluded.paid_through), status = excluded.status
					 WHERE subscriptions.account_id IS NOT NULL AND subscriptions.revoked_at IS NULL
					 AND subscriptions.status != 'canceled'
					 AND ${revokedPayment.replace('?', '?9')} IS NULL`
				).bind(
					paid.subscription.id,
					account?.id ?? null,
					paid.plan,
					paid.subscription.customer,
					paid.periodEnd,
					paid.subscription.status,
					t,
					paid.paymentIntentId,
					paid.paymentIntentId,
					knownSubscription ? 1 : 0
				),
				env.DB.prepare(
					`UPDATE subscriptions SET cancel_at_period_end = ?, cancel_at = ?
					 WHERE id = ? AND account_id IS NOT NULL AND revoked_at IS NULL AND status != 'canceled'`
				).bind(
					paid.subscription.cancel_at_period_end === true ? 1 : 0,
					paid.subscription.cancel_at ?? null,
					paid.subscription.id
				),
				// 試用の 0 円請求書は、売上の台帳に残さない。
				...(paid.amount === 0 || !paid.paymentIntentId
					? []
					: [
							env.DB.prepare(
								`INSERT INTO purchases (id, account_id, product, stripe_checkout_session_id, stripe_payment_intent_id,
						 amount, currency, managed_payments, card_country, buyer_country, domestic, stripe_subscription_id, created_at, revoked_at)
							 VALUES (?, ?, '${PRO_PRODUCT}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
						 ${revokedPayment.replace('?', '?13')})
								 ON CONFLICT DO NOTHING`
							).bind(
								randomHex(16),
								account?.id ?? null,
								`invoice:${paid.invoiceId}`,
								paid.paymentIntentId,
								paid.amount,
								paid.currency,
								paid.managedPayments ? 1 : 0,
								paid.cardCountry,
								paid.buyerCountry,
								paid.domestic ? 1 : 0,
								paid.subscription.id,
								t,
								paid.paymentIntentId
							)
						])
			]);
			const revoked =
				paid.paymentIntentId &&
				(await env.DB.prepare('SELECT 1 FROM stripe_revoked_payments WHERE payment_intent_id = ?')
					.bind(paid.paymentIntentId)
					.first());
			const duplicate =
				!knownSubscription && account && paid.subscription.status !== 'canceled' && !revoked
					? await env.DB.prepare(
							`SELECT 1 FROM subscriptions
							 WHERE account_id = ? AND id != ? AND revoked_at IS NULL AND ${proUntilSql} > ?`
						)
							.bind(account.id, paid.subscription.id, t)
							.first()
					: null;
			// 返金・不審請求が先に届いていたときは、期間を延ばさず Stripe 側も打ち切る。
			if (!account || duplicate || revoked) await cancelSubscription(config, paid.subscription.id);
			if (duplicate) {
				await reportProInvoiceProblem(
					env,
					String(object.id),
					'同じアカウントに、まだ有効な別の Pro のサブスクがあります。返金は運営で判断します。'
				);
				return 'failed';
			}
			return;
		}
		case 'customer.subscription.updated':
		case 'customer.subscription.deleted': {
			const row = await env.DB.prepare('SELECT id, status FROM subscriptions WHERE id = ?')
				.bind(String(object.id))
				.first<{ id: string; status: string }>();
			if (!row || row.status === 'canceled') return;
			const sub = await getSubscription(config, row.id);
			await env.DB.prepare(
				"UPDATE subscriptions SET status = ?, cancel_at_period_end = ?, cancel_at = ? WHERE id = ? AND status != 'canceled'"
			)
				.bind(sub.status, sub.cancel_at_period_end === true ? 1 : 0, sub.cancel_at ?? null, row.id)
				.run();
			return;
		}
		// カードは completed の時点で払われている。MP の Session では後から払う方法も選べ、払われると async_payment_succeeded が届く。
		case 'checkout.session.completed':
		case 'checkout.session.async_payment_succeeded': {
			const metadata = object.metadata as Record<string, string> | null;
			if (metadata?.product !== PRODUCT || object.payment_status !== 'paid') return;
			const purchase = await confirmPurchase(config, String(object.id));
			if (!purchase) return;
			// 台帳に残してから、残高を付ける。1つのトランザクションにし、確かめる処理と付ける処理を分けない。
			// アカウントが無ければ、台帳には結び付き無しで残し、残高は付けない。
			// 返金・不審請求の知らせが先に届いていれば、取り消し済みとして残し、残高は付けない。
			const t = now();
			await env.DB.batch([
				env.DB.prepare(
					`INSERT INTO purchases
					   (id, account_id, product, stripe_checkout_session_id, stripe_payment_intent_id,
					    amount, currency, managed_payments, card_country, buyer_country, domestic, created_at,
					    revoked_at)
					 VALUES (?1, (SELECT id FROM accounts WHERE id = ?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?12, ?11,
					   (SELECT created_at FROM stripe_revoked_payments WHERE payment_intent_id = ?5))
					 ON CONFLICT DO NOTHING`
				).bind(
					randomHex(16),
					purchase.accountId,
					PRODUCT,
					purchase.sessionId,
					purchase.paymentIntentId,
					purchase.amount,
					purchase.currency,
					purchase.managedPayments ? 1 : 0,
					purchase.cardCountry,
					purchase.buyerCountry,
					t,
					purchase.domestic ? 1 : 0
				),
				env.DB.prepare(
					`INSERT INTO grants (id, account_id, purchase_id, granted, remaining, created_at)
					 SELECT ?1, account_id, id, ?2, ?2, ?3 FROM purchases
					 WHERE stripe_checkout_session_id = ?4 AND account_id IS NOT NULL AND revoked_at IS NULL
					 ON CONFLICT DO NOTHING`
				).bind(randomHex(16), pricing(env).purchaseGrant, t, purchase.sessionId),
				// 支払いの画面の予約を外す。次の買い足しで、払い終えた画面へ送らないように。
				env.DB.prepare('DELETE FROM checkouts WHERE account_id = ?').bind(purchase.accountId)
			]);
			return;
		}
		// 全額を返金したとき・不審請求を申し立てられたときは、その購入の残りを取り消す。使った分は取り戻さない。
		case 'charge.refunded':
		case 'charge.dispute.created': {
			if (type === 'charge.refunded' && object.refunded !== true) return;
			if (typeof object.payment_intent !== 'string') return;
			// 付ける知らせが後から届いても付けないよう、取り消した支払いを覚えておく。台帳の行は消さない。
			const t = now();
			await env.DB.batch([
				env.DB.prepare(
					`INSERT INTO stripe_revoked_payments (payment_intent_id, created_at) VALUES (?, ?)
					 ON CONFLICT DO NOTHING`
				).bind(object.payment_intent, t),
				env.DB.prepare(
					`UPDATE purchases SET revoked_at = ?
					 WHERE stripe_payment_intent_id = ? AND revoked_at IS NULL`
				).bind(t, object.payment_intent),
				env.DB.prepare(
					`UPDATE grants SET revoked = revoked + remaining, remaining = 0 WHERE purchase_id IN
					   (SELECT id FROM purchases WHERE stripe_payment_intent_id = ?)`
				).bind(object.payment_intent),
				env.DB.prepare(
					`UPDATE grants SET revoked = revoked + remaining, remaining = 0
					 WHERE account_id = (SELECT account_id FROM purchases WHERE stripe_payment_intent_id = ?1)
					   AND (SELECT product FROM purchases WHERE stripe_payment_intent_id = ?1) = '${PRO_PRODUCT}'
					   AND kind = 'pro' AND expires_at > ?2
					   -- 二重に払われた片方を返金しても、残るサブスクの Pro で付けた分は取り消さない
					   AND NOT EXISTS (
					     SELECT 1 FROM subscriptions
					     WHERE account_id = grants.account_id AND revoked_at IS NULL AND ${proUntilSql} > ?2
					       AND id != (SELECT stripe_subscription_id FROM purchases WHERE stripe_payment_intent_id = ?1))`
				).bind(object.payment_intent, t),
				env.DB.prepare(
					`UPDATE subscriptions SET revoked_at = coalesce(revoked_at, ?)
					 WHERE id = (SELECT stripe_subscription_id FROM purchases WHERE stripe_payment_intent_id = ?)`
				).bind(t, object.payment_intent)
			]);
			const sub = await env.DB.prepare(
				'SELECT stripe_subscription_id FROM purchases WHERE stripe_payment_intent_id = ?'
			)
				.bind(object.payment_intent)
				.first<{ stripe_subscription_id: string | null }>();
			if (sub?.stripe_subscription_id) await cancelSubscription(config, sub.stripe_subscription_id);
			return;
		}
	}
}

async function reportProInvoiceProblem(env: Env, invoiceId: string, reason: string) {
	const subject = '[Mawok] 請求書で Pro を付けられませんでした';
	const text = `請求書 ${invoiceId} は払われましたが、Pro を付けていません。\n\nわけ: ${reason}`;
	if (env.OPERATOR_EMAIL) return sendMail(env, env.OPERATOR_EMAIL, subject, text);
	console.error(`${subject}\n${text}`);
}
