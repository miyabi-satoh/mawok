-- 窓口の表 (→ docs/account-server.md「窓口（mawok.amiiby.com）」)。時刻は UNIX 秒、原価は 1/1000 円 (milli_yen)。

CREATE TABLE accounts (
	id TEXT PRIMARY KEY,
	-- 小文字にそろえて持つ。
	email TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL
);

-- メールのサインインのリンク。トークンはハッシュだけを持つ。
CREATE TABLE email_logins (
	token_hash TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	next TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	used_at INTEGER
);
CREATE INDEX email_logins_email ON email_logins (email, created_at);

-- ブラウザのサインインの状態。
CREATE TABLE sessions (
	id_hash TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

-- 外部のサインイン (Google・Apple) とアカウントの結び付き。
CREATE TABLE identities (
	provider TEXT NOT NULL,
	subject TEXT NOT NULL,
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (provider, subject)
);

-- Mawok からの、アカウントと結ぶ申し込み。結んだら、期限まではアプリ用のトークンを問い合わせのたびに渡す。
CREATE TABLE links (
	id TEXT PRIMARY KEY,
	poll_secret_hash TEXT NOT NULL,
	user_code TEXT NOT NULL UNIQUE,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	account_id TEXT REFERENCES accounts (id) ON DELETE CASCADE,
	-- 結んだときに作ったトークン。Mawok に一度渡したら消す。渡す前に期限が過ぎても消す。
	token TEXT,
	approved_at INTEGER
);

-- Mawok に渡したトークン。ハッシュだけを持つ。期限は持たず、サインアウトか窓口の画面で消す。
CREATE TABLE app_tokens (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);
CREATE INDEX app_tokens_account ON app_tokens (account_id);

-- 支払いの画面の予約。アカウントごとに1つ。
CREATE TABLE checkouts (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
	next TEXT NOT NULL,
	lang TEXT NOT NULL,
	url TEXT,
	expires_at INTEGER NOT NULL,
	managed_payments INTEGER NOT NULL,
	-- 予約したときのアクセス元の国。頼み直しでも同じ中身で頼み、MP の扱いと台帳の国を食い違わせない。
	buyer_country TEXT
);

-- Stripe からの知らせ。処理し終えたものを送り直されても処理し直さない。
CREATE TABLE stripe_events (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('received', 'done', 'failed')),
	received_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

-- 返金・不審請求で取り消した支払い。付ける知らせが後から届いても付けないように。
CREATE TABLE stripe_revoked_payments (
	payment_intent_id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL
);

-- 購入の台帳。アカウントを消しても、結び付きを外して 7 年残す (消費税の帳簿の保存期間)。
CREATE TABLE purchases (
	id TEXT PRIMARY KEY,
	account_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,
	product TEXT NOT NULL,
	stripe_checkout_session_id TEXT NOT NULL UNIQUE,
	stripe_payment_intent_id TEXT NOT NULL UNIQUE,
	-- 払われた額 (税込み) と通貨。
	amount INTEGER NOT NULL,
	currency TEXT NOT NULL,
	-- 消費税の申告で売上を分けるため、アカウントを消しても残す。
	managed_payments INTEGER NOT NULL,
	-- カードの発行国と、買ったときのアクセス元の国。アカウントを消したら消す。
	card_country TEXT,
	buyer_country TEXT,
	-- 国内の取引か (src/stripe.ts の domestic)。消費税の申告で使った分の国内の分を数えるため、アカウントを消しても残す。
	domestic INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	revoked_at INTEGER,
	detached_at INTEGER
);

-- 残高。付与ごとに1行。purchase_id が無いものは、新しいアカウントに付ける無料の分。
CREATE TABLE grants (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	purchase_id TEXT UNIQUE REFERENCES purchases (id),
	granted INTEGER NOT NULL,
	remaining INTEGER NOT NULL,
	-- 返金・不審請求で取り消した残り。
	revoked INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	CHECK (remaining >= 0 AND revoked >= 0 AND remaining + revoked <= granted)
);
CREATE INDEX grants_account ON grants (account_id);

-- 使った分。残高を引くたびに、引いた付与ごとに1行。消費税の申告で、使った時の売上を数えるため (→ docs/account-server.md「残高」)。
-- アカウントとは結ばない。購入の分は purchase_id で台帳と結び、台帳と一緒に消える。無料の分は purchase_id が無い。
CREATE TABLE consumptions (
	id TEXT PRIMARY KEY,
	purchase_id TEXT REFERENCES purchases (id) ON DELETE CASCADE,
	milli_yen INTEGER NOT NULL CHECK (milli_yen > 0),
	created_at INTEGER NOT NULL
);
CREATE INDEX consumptions_created ON consumptions (created_at);
CREATE INDEX consumptions_purchase ON consumptions (purchase_id);

-- AI に中継している最中のアカウント。同じアカウントは同時に1件だけ。
CREATE TABLE ai_in_flight (
	account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
	-- 印を取った中継の番号。外すときは自分の印だけを外す (古い中継が、取り直した新しい中継の印を外さないように)。
	owner TEXT NOT NULL,
	started_at INTEGER NOT NULL
);
