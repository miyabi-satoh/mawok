import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { messages, type Lang } from './i18n';
import type { Balance, Pro } from './credits';
import { ACCOUNT, ACCOUNT_HOME, PRICING_PATH, PURCHASE_CONDITIONS } from './util';

/** 規約類の置き場。利用規約とプライバシーポリシーは同じ Worker の静的アセットで出す (→ docs/account-server.md「作り」)。
 * 特商法の表記は amiiby.com の全製品に共通のページで、価格・動作環境と Mawok に限った定めは料金ページの PURCHASE_CONDITIONS に書く。 */
export const LEGAL_PAGES = {
	terms: '/terms/',
	privacy: '/privacy/',
	tokushoho: 'https://amiiby.com/tokushoho/'
} as const;

type Body = HtmlEscapedString | Promise<HtmlEscapedString>;

// 差し色は amiiby.com の Mawok の色に合わせる。
// 足もとの紹介と規約類は日本語だけなので、英語の画面からも同じ所へリンクする。
function page(lang: Lang, title: string, body: Body) {
	const t = messages[lang];
	return html`<!doctype html>
		<html lang="${lang}">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="referrer" content="no-referrer" />
				<title>${title} - Mawok</title>
				<style>
					:root {
						color-scheme: light dark;
						--accent: #33358a;
						--fg: #1f2328;
						--muted: #59636e;
						--bg: #ffffff;
						--border: #d1d9e0;
					}
					@media (prefers-color-scheme: dark) {
						:root {
							--accent: #9a9cf0;
							--fg: #e6edf3;
							--muted: #9198a1;
							--bg: #0d1117;
							--border: #3d444d;
						}
					}
					body {
						margin: 0;
						background: var(--bg);
						color: var(--fg);
						font-family: system-ui, sans-serif;
						line-height: 1.7;
						word-break: auto-phrase;
					}
					main {
						max-width: 28rem;
						margin: 3rem auto;
						padding: 0 1rem;
					}
					h1 {
						font-size: 1.25rem;
					}
					.muted {
						color: var(--muted);
						font-size: 0.875rem;
					}
					label {
						display: block;
						margin-bottom: 0.25rem;
					}
					input {
						box-sizing: border-box;
						width: 100%;
						min-height: 44px;
						padding: 0 0.75rem;
						font: inherit;
						border: 1px solid var(--border);
						border-radius: 6px;
						background: transparent;
						color: inherit;
						word-break: normal;
					}
					button {
						min-height: 44px;
						margin-top: 1rem;
						padding: 0 1.25rem;
						font: inherit;
						border: 0;
						border-radius: 6px;
						background: var(--accent);
						color: #fff;
						cursor: pointer;
					}
					a {
						color: var(--accent);
					}
					/* Google のブランドの決まりに合わせ、白地に枠と G のロゴを置く。 */
					a.google {
						display: inline-flex;
						align-items: center;
						gap: 0.75rem;
						min-height: 44px;
						padding: 0 1.25rem;
						border: 1px solid var(--border);
						border-radius: 6px;
						background: #fff;
						color: #1f1f1f;
						text-decoration: none;
					}
					/* Apple の決まり (HIG の Sign in with Apple) に合わせ、明るい地では黒、暗い地では白にする。 */
					a.apple {
						display: inline-flex;
						align-items: center;
						gap: 0.75rem;
						min-height: 44px;
						padding: 0 1.25rem;
						border-radius: 6px;
						background: #000;
						color: #fff;
						text-decoration: none;
					}
					@media (prefers-color-scheme: dark) {
						a.apple {
							background: #fff;
							color: #000;
						}
					}
					.providers {
						display: flex;
						flex-wrap: wrap;
						gap: 0.75rem;
					}
					.account {
						margin-top: 2.5rem;
					}
					/* 文の途中で折り返してボタンと並ばないよう、ボタンは次の行に置く。 */
					.account button {
						display: block;
					}
					footer {
						margin-top: 3rem;
						display: flex;
						flex-wrap: wrap;
						gap: 0.25rem 1rem;
					}
					footer a {
						color: var(--muted);
					}
					dl.order {
						margin: 1.5rem 0;
						padding: 1rem 1.25rem;
						border: 1px solid var(--border);
						border-radius: 8px;
					}
					dl.order dt {
						font-weight: bold;
					}
					dl.order dd {
						margin: 0 0 0.75rem;
					}
					dl.order dd:last-child {
						margin-bottom: 0;
					}
					a.action {
						display: inline-flex;
						align-items: center;
						min-height: 44px;
						padding: 0 1.25rem;
						border-radius: 6px;
						background: var(--accent);
						color: #fff;
						text-decoration: none;
					}
					h2 {
						font-size: 1rem;
						margin-top: 2rem;
					}
					form.inline button {
						margin: 0 0 0 0.75rem;
						min-height: 36px;
					}
					button.secondary {
						background: transparent;
						color: var(--accent);
						border: 1px solid var(--border);
					}
				</style>
			</head>
			<body>
				<main>
					${body}
					<footer class="muted">
						<a href="/">${t.about}</a>
						<a href="${LEGAL_PAGES.terms}">${t.terms}</a>
						<a href="${LEGAL_PAGES.privacy}">${t.privacy}</a>
						<a href="${LEGAL_PAGES.tokushoho}">${t.tokushoho}</a>
					</footer>
				</main>
			</body>
		</html>`;
}

/** 同意の文言から指せるページ。購入で同意するのは、共通の特商法の表記でなく Mawok の購入の条件。 */
const CONSENT_LINKS = {
	terms: LEGAL_PAGES.terms,
	privacy: LEGAL_PAGES.privacy,
	conditions: PURCHASE_CONDITIONS
};

/** 文言の `{terms}` などを、そのページへのリンクにする。 */
function withLegalLinks(lang: Lang, text: string) {
	const t = messages[lang];
	return text
		.split(/\{(terms|privacy|conditions)\}/)
		.map((part, i) =>
			i % 2 === 1
				? html`<a href="${CONSENT_LINKS[part as keyof typeof CONSENT_LINKS]}"
						>${t[part as keyof typeof CONSENT_LINKS]}</a
					>`
				: part
		);
}

/** 文言の `[文](https://…)` をリンクにする。文言はこちらで書くもので、利用者の入力は通さない。 */
function withLinks(text: string) {
	// 文言は手元で書いたものだけなので、外のサイトのほかに、同じサイトのパス (規約類) も結ぶ
	const parts = text.split(/\[([^\]]+)\]\(((?:https:\/\/|\/)[^)\s]+)\)/);
	return parts.map((part, i) =>
		i % 3 === 1 ? html`<a href="${parts[i + 1]}">${part}</a>` : i % 3 === 2 ? '' : part
	);
}

// Google の標準の G のロゴ (Sign in with Google のブランドの決まり)。
const GOOGLE_LOGO = html`<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
	<path
		fill="#EA4335"
		d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
	/>
	<path
		fill="#4285F4"
		d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
	/>
	<path
		fill="#FBBC05"
		d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
	/>
	<path
		fill="#34A853"
		d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
	/>
</svg>`;

// Apple のロゴ。形は Apple Design Resources の Sign in with Apple のボタンと同じ。色は文言と同じ (HIG により黒か白だけ)。
const APPLE_LOGO = html`<svg width="18" height="18" viewBox="4.48 9 22 22" aria-hidden="true">
	<path
		fill="currentColor"
		d="M15.71 14.885c.858 0 1.933-.58 2.573-1.353.58-.7 1.002-1.679 1.002-2.657 0-.133-.012-.266-.036-.375-.954.036-2.102.64-2.79 1.45-.544.616-1.039 1.582-1.039 2.572 0 .145.024.29.036.339.06.012.157.024.254.024ZM12.69 29.5c1.172 0 1.691-.785 3.153-.785 1.486 0 1.812.76 3.116.76 1.28 0 2.138-1.183 2.947-2.342.906-1.329 1.28-2.634 1.305-2.694-.085-.024-2.537-1.027-2.537-3.841 0-2.44 1.933-3.539 2.042-3.624-1.28-1.836-3.225-1.884-3.757-1.884-1.437 0-2.609.87-3.346.87-.797 0-1.848-.822-3.092-.822-2.367 0-4.771 1.957-4.771 5.653 0 2.295.894 4.723 1.993 6.293.942 1.329 1.764 2.416 2.947 2.416Z"
	/>
</svg>`;

/** `google`・`apple`: その方法でサインインできるとき (→ src/google.ts・src/apple.ts) に、そのボタンを先に出す。 */
export function signInPage(
	lang: Lang,
	next: string,
	{
		error,
		google = false,
		apple = false
	}: { error?: string; google?: boolean; apple?: boolean } = {}
) {
	const t = messages[lang];
	const query = new URLSearchParams({ next });
	return page(
		lang,
		t.signInTitle,
		html`<h1>${t.signInHeading}</h1>
			${error ? html`<p role="alert">${error}</p>` : ''}
			${
				google || apple
					? html`<p class="providers">
								${
									google
										? html`<a class="google" href="${ACCOUNT}/login/google?${query}"
												>${GOOGLE_LOGO}${t.signInWithGoogle}</a
											>`
										: ''
								}
								${
									apple
										? html`<a class="apple" href="${ACCOUNT}/login/apple?${query}"
												>${APPLE_LOGO}${t.signInWithApple}</a
											>`
										: ''
								}
							</p>
							<p>${t.signInWithEmail}</p>`
					: html`<p>${t.signInLead}</p>`
			}
			<form method="post" action="${ACCOUNT}/login/email">
				<label for="email">${t.email}</label>
				<input id="email" name="email" type="email" autocomplete="email" required />
				<input type="hidden" name="next" value="${next}" />
				<button>${t.sendLink}</button>
			</form>
			<p class="muted">${withLegalLinks(lang, t.signInConsent)}</p>`
	);
}

/**
 * メールを送ったところ。Mawok を結ぶ途中なら、リンクを同じパソコンで開くよう添える。
 * 結ぶとブラウザを 127.0.0.1 へ戻すので、ほかの機器で開くと Mawok へ戻れないため。
 */
export function mailSentPage(lang: Lang, email: string, minutes: number, linking: boolean) {
	const t = messages[lang];
	return page(
		lang,
		t.mailSentTitle,
		html`<h1>${t.mailSentTitle}</h1>
			<p>${t.mailSent(email, minutes)}</p>
			${linking ? html`<p>${t.mailSentSameComputer}</p>` : ''}
			<p class="muted">${t.mailSentHint}</p>`
	);
}

/** メールのリンクを開いたところ。開いただけではサインインしない (→ POST /login/email/verify)。 */
export function confirmSignInPage(lang: Lang, token: string) {
	const t = messages[lang];
	return page(
		lang,
		t.signInTitle,
		html`<h1>${t.signInHeading}</h1>
			<form method="post" action="${ACCOUNT}/login/email/verify">
				<input type="hidden" name="token" value="${token}" />
				<button>${t.signIn}</button>
			</form>`
	);
}

export function messagePage(lang: Lang, title: string, message: string) {
	return page(
		lang,
		title,
		html`<h1>${title}</h1>
			<p>${message}</p>`
	);
}

function signedInAs(lang: Lang, email: string, next: string) {
	const t = messages[lang];
	return html`<form method="post" action="${ACCOUNT}/logout" class="muted account">
		${t.signedInAs(email)}
		<input type="hidden" name="next" value="${next}" />
		<button class="secondary">${t.signOut}</button>
	</form>`;
}

/**
 * 結ぶ前の確かめ。押すと、ブラウザを Mawok の待ち受けへ戻す。
 * 申し込みの値は押すまでフォームに持ち、押したときに窓口が確かめ直す。
 */
export function approvePage(lang: Lang, email: string, link: LinkRequest, here: string) {
	const t = messages[lang];
	return page(
		lang,
		t.linkTitle,
		html`<h1>${t.linkTitle}</h1>
			<p>${t.linkConfirm(link.name)}</p>
			<form method="post" action="${ACCOUNT}/link">
				<input type="hidden" name="port" value="${String(link.port)}" />
				<input type="hidden" name="state" value="${link.state}" />
				<input type="hidden" name="challenge" value="${link.challenge}" />
				<input type="hidden" name="name" value="${link.name}" />
				<button>${t.approve}</button>
			</form>
			${signedInAs(lang, email, here)}`
	);
}

/** 国内 (Stripe で直接売る) と海外 (Managed Payments で、Link が代わりに売る)。売り方で説明が変わる。 */
export type SaleRegion = 'domestic' | 'overseas';

/** 支払いの直前の最終確認画面。条件はボタンより上に、畳まずに出す。 */
export function confirmPage(lang: Lang, email: string, region: SaleRegion) {
	const t = messages[lang];
	const rows: [string, string][] = [
		[t.confirmItemLabel, t.confirmItem],
		[t.confirmPriceLabel, t.confirmPrice],
		[t.confirmPaymentLabel, t.confirmPayment[region]],
		[t.confirmDeliveryLabel, t.confirmDelivery],
		[t.confirmRefundLabel, t.confirmRefund[region](LEGAL_PAGES.tokushoho)]
	];
	return page(
		lang,
		t.confirmTitle,
		html`<h1>${t.confirmTitle}</h1>
			<dl class="order">
				${rows.map(
					([label, value]) =>
						html`<dt>${label}</dt>
							<dd>${withLinks(value)}</dd>`
				)}
			</dl>
			<form method="post" action="${ACCOUNT}/buy">
				<p class="muted">${withLegalLinks(lang, t.buyConsent)}</p>
				<input type="hidden" name="next" value="${ACCOUNT_HOME}" />
				<button>${t.confirmButton}</button>
			</form>
			<p><a href="${PRICING_PATH}">${t.backToPricing}</a></p>
			${signedInAs(lang, email, `${ACCOUNT}/buy`)}`
	);
}

/** Pro の支払いの直前の最終確認画面。 */
export function proConfirmPage(
	lang: Lang,
	email: string,
	plan: 'monthly' | 'yearly',
	region: SaleRegion,
	{ trial }: { trial: boolean }
) {
	const t = messages[lang];
	const rows: [string, string][] = [
		[t.confirmItemLabel, t.proItem(plan)],
		[t.confirmPriceLabel, t.proPrice(plan)],
		[t.confirmPaymentLabel, t.proPayment[region]],
		[t.confirmDeliveryLabel, t.proDelivery],
		[t.confirmRefundLabel, t.confirmRefund[region](LEGAL_PAGES.tokushoho)]
	];
	return page(
		lang,
		t.proTitle,
		html`<h1>${t.confirmTitle}</h1>
			<dl class="order">
				${rows.map(
					([label, value]) =>
						html`<dt>${label}</dt>
							<dd>${withLinks(value)}</dd>`
				)}
			</dl>
			${trial ? html`<p>${t.proTrial}</p>` : ''}
			<form method="post" action="${ACCOUNT}/buy">
				<p class="muted">${withLegalLinks(lang, t.buyConsent)}</p>
				<input type="hidden" name="next" value="${ACCOUNT_HOME}" /><input
					type="hidden"
					name="plan"
					value="${plan}"
				/>
				<button>${t.confirmButton}</button>
			</form>
			<p><a href="${PRICING_PATH}">${t.backToPricing}</a></p>
			${signedInAs(lang, email, `${ACCOUNT}/buy?plan=${plan}`)}`
	);
}

/** Mawok が申し込みに付けた値。 */
export type LinkRequest = { port: number; state: string; challenge: string; name: string };

/** Mawok に渡したトークン。窓口の画面から外せる。 */
export type LinkedApp = { id: string; name: string; createdAt: number };

export function homePage(
	lang: Lang,
	email: string,
	balance: Balance,
	apps: LinkedApp[],
	region: SaleRegion | undefined,
	{ bought = false, pro, billing = false }: { bought?: boolean; pro?: Pro; billing?: boolean } = {}
) {
	const t = messages[lang];
	const date = (seconds: number) =>
		new Date(seconds * 1000).toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-US', {
			timeZone: 'Asia/Tokyo'
		});
	return page(
		lang,
		t.accountTitle,
		html`<h1>${t.accountTitle}</h1>
			${bought ? html`<p role="status">${t.bought}</p>` : ''}
			<p>${balance.remaining > 0 ? t.balance(balance.percent) : t.noBalance}</p>
			${region ? html`<p><a class="action" href="${PRICING_PATH}">${t.buyTitle}</a></p>` : ''}
			<h2>${t.proTitle}</h2>
			${
				pro?.active
					? html`<p>
								${pro.trial ? t.proTrialUntil(date(pro.until!)) : t.proUntil(pro.plan!, date(pro.until!))}
							</p>
							${billing ? html`<form method="post" action="${ACCOUNT}/billing"><button class="secondary">${t.manageBilling}</button></form>` : ''}`
					: region
						? html`<p><a class="action" href="${PRICING_PATH}">${t.proSubscribe}</a></p>`
						: html`<p>${t.proUnavailable}</p>`
			}
			<h2>${t.appsTitle}</h2>
			${
				apps.length === 0
					? html`<p>${t.appsNone}</p>`
					: html`<ul>
							${apps.map(
								(app) =>
									html`<li>
										<form method="post" action="${ACCOUNT}/apps/unlink" class="inline">
											${t.appLinkedAt(app.name, date(app.createdAt))}
											<input type="hidden" name="id" value="${app.id}" />
											<button class="secondary">${t.unlink}</button>
										</form>
									</li>`
							)}
						</ul>`
			}
			${signedInAs(lang, email, ACCOUNT_HOME)}`
	);
}

/**
 * 支払いから戻った先で、残高が付くのを待つ画面。`autoRetry` の間は数秒おきに開き直す。
 * 待っても付かなければ、確かめ直す手段を出す (買えたか分からないまま買い直さないように)。
 */
export function checkingPurchasePage(lang: Lang, retryUrl: string, autoRetry: boolean) {
	const t = messages[lang];
	return page(
		lang,
		t.buyTitle,
		html`${autoRetry ? html`<meta http-equiv="refresh" content="3;url=${retryUrl}" />` : ''}
			<h1>${t.buyTitle}</h1>
			<p>${autoRetry ? t.checkingPurchase : t.purchaseNotYet}</p>
			${autoRetry ? '' : html`<p><a href="${retryUrl}">${t.checkAgain}</a></p>`}`
	);
}
