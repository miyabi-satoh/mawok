// 無くても動く秘密の値。無いときの扱いは各モジュール。
interface __BaseEnv_Env {
	/** Resend の API キー。 */
	RESEND_API_KEY?: string;
	/** 手元で動かすときだけ "1"。メールを送らず、リンクをログに出す。 */
	MAIL_LOG_ONLY?: string;
	/** Stripe (→ src/stripe.ts)。2つと税率・Pro の Price がそろったときだけ売る。 */
	STRIPE_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;
	/** Pro の月額・年額の Price の id。 */
	STRIPE_PRO_MONTHLY_PRICE_ID?: string;
	STRIPE_PRO_YEARLY_PRICE_ID?: string;
	/** Pro の請求書を受け付けられなかったときの連絡先。無ければログに残す。 */
	OPERATOR_EMAIL?: string;
	/** Google でのサインイン (→ src/google.ts)。2つそろったときだけ出す。 */
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	/** Apple でのサインイン (→ src/apple.ts)。4つそろったときだけ出す。秘密鍵は .p8 の中身。 */
	APPLE_TEAM_ID?: string;
	APPLE_KEY_ID?: string;
	APPLE_PRIVATE_KEY?: string;
	APPLE_SERVICE_ID?: string;
}
