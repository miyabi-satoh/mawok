// 無くても動く秘密の値。無いときの扱いは各モジュール。
// 欠かせないもの (Gemini のキー) は wrangler.jsonc の `secrets.required` に書き、生成した型に入る。
interface __BaseEnv_Env {
	/** Resend の API キー。 */
	RESEND_API_KEY?: string;
	/** 手元で動かすときだけ "1"。メールを送らず、リンクをログに出す。 */
	MAIL_LOG_ONLY?: string;
	/** Stripe (→ src/stripe.ts)。3つと税率がそろったときだけ売る。 */
	STRIPE_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;
	/** AI アクションのクレジット (300 円) の Price の id。 */
	STRIPE_AI_CREDITS_PRICE_ID?: string;
	/** Pro の月額・年額の Price の id。 */
	STRIPE_PRO_MONTHLY_PRICE_ID?: string;
	STRIPE_PRO_YEARLY_PRICE_ID?: string;
	/** Google でのサインイン (→ src/google.ts)。2つそろったときだけ出す。 */
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	/** Apple でのサインイン (→ src/apple.ts)。4つそろったときだけ出す。秘密鍵は .p8 の中身。 */
	APPLE_TEAM_ID?: string;
	APPLE_KEY_ID?: string;
	APPLE_PRIVATE_KEY?: string;
	APPLE_SERVICE_ID?: string;
}
