-- Pro のサブスクと、月ごとに失効する Pro のクレジット。

CREATE TABLE subscriptions (
	id TEXT PRIMARY KEY,
	account_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,
	plan TEXT NOT NULL CHECK (plan IN ('monthly', 'yearly')),
	stripe_customer_id TEXT,
	paid_through INTEGER NOT NULL,
	status TEXT NOT NULL,
	revoked_at INTEGER,
	created_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_account ON subscriptions (account_id);

ALTER TABLE purchases ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE checkouts ADD COLUMN price TEXT NOT NULL DEFAULT '';
ALTER TABLE checkouts ADD COLUMN session_id TEXT;

ALTER TABLE grants ADD COLUMN kind TEXT NOT NULL DEFAULT 'free' CHECK (kind IN ('purchase', 'free', 'pro'));
ALTER TABLE grants ADD COLUMN expires_at INTEGER;
UPDATE grants SET kind = CASE WHEN purchase_id IS NULL THEN 'free' ELSE 'purchase' END;
CREATE INDEX grants_expiring ON grants (account_id, kind, expires_at);
-- 消費の記録はアカウント削除後も残す。付与を消しても行を残せるよう、参照だけを外す。
ALTER TABLE consumptions ADD COLUMN grant_id TEXT REFERENCES grants (id) ON DELETE SET NULL;
ALTER TABLE consumptions ADD COLUMN grant_kind TEXT;
-- 導入前の消費にも付与の種類を残す。どの付与から使ったかは当時記録していないので grant_id は NULL のままにする。
UPDATE consumptions SET grant_kind = CASE WHEN purchase_id IS NULL THEN 'free' ELSE 'purchase' END;

-- Stripe の期間末解約を、アカウントの画面でも出す。
ALTER TABLE subscriptions ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
