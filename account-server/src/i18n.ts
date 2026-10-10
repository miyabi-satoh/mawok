/**
 * 画面とメールの言語。「クエリの `lang` (`ja`・`en`) > cookie > ブラウザの言語 > 英語」で決める。
 * Mawok から開くリンクには `lang` が付き、Mawok で選んでいる言語に合わせる。
 */
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { SaleRegion } from './pages';
import { isHttps } from './util';

export type Lang = 'ja' | 'en';

const COOKIE = 'lang';

/** Managed Payments で売った分の返金の決まり。購入から60日以内は、こちらの決まりより Link のものが優先する。 */
const LINK_REFUND_POLICY =
	'https://support.link.com/questions/requesting-a-refund-for-a-sold-through-link-payment';

export function isLang(value: string | undefined): value is Lang {
	return value === 'ja' || value === 'en';
}

/** `Accept-Language` のうち、持っている言語で最も好まれるもの。 */
function preferredLang(header: string | undefined): Lang | undefined {
	const tags = (header ?? '')
		.split(',')
		.map((part) => {
			const [tag, ...params] = part.trim().split(';');
			const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
			return { lang: tag.toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) : 1 };
		})
		.filter((t) => isLang(t.lang) && t.q > 0)
		.sort((a, b) => b.q - a.q);
	return tags[0]?.lang as Lang | undefined;
}

/** この要求の言語。`lang` が付いていれば cookie に残し、以後の画面もそれに合わせる。 */
export function resolveLang(c: Context): Lang {
	const asked = c.req.query('lang');
	if (isLang(asked)) {
		setCookie(c, COOKIE, asked, {
			path: '/',
			maxAge: 400 * 24 * 60 * 60,
			sameSite: 'Lax',
			secure: isHttps(c)
		});
		return asked;
	}
	const saved = getCookie(c, COOKIE);
	if (isLang(saved)) return saved;
	return preferredLang(c.req.header('accept-language')) ?? 'en';
}

const ja = {
	signInTitle: 'サインイン',
	signInHeading: 'Mawok にサインイン',
	signInLead: 'メールアドレスにサインインのリンクを送ります。',
	signInWithGoogle: 'Google でサインイン',
	// Apple の決まり (HIG) の文言のまま。
	signInWithApple: 'Appleでサインイン',
	signInWithEmail: 'または、メールアドレスにサインインのリンクを送ります。',
	signInConsent:
		'サインインすると、{terms}と{privacy}に同意したことになります (アメリカ合衆国の事業者への個人情報の提供を含みます)。',
	googleFailed: 'Google でサインインできませんでした。もう一度試してください。',
	googleUnconfirmed:
		'この Google アカウントでは、メールアドレスの持ち主を確かめられません。メールアドレスに送るリンクでサインインしてください。',
	googleConflict:
		'このメールアドレスのアカウントは、別の Google アカウントでサインインするようになっています。そちらの Google アカウントか、メールアドレスに送るリンクでサインインしてください。',
	appleFailed: 'Apple でサインインできませんでした。もう一度試してください。',
	appleConflict:
		'このメールアドレスのアカウントは、別の Apple アカウントでサインインするようになっています。そちらの Apple アカウントか、メールアドレスに送るリンクでサインインしてください。',
	email: 'メールアドレス',
	sendLink: 'リンクを送る',
	invalidEmail: 'メールアドレスを確かめてください。',
	tooManyLinks: 'リンクを送った回数が多すぎます。しばらくしてから試してください。',
	mailSentTitle: 'メールを送りました',
	mailSent: (email: string, minutes: number) =>
		`${email} に届いたリンクを開いてください。リンクは ${minutes} 分で切れます。`,
	mailSentHint: '届かないときは、迷惑メールのフォルダも確かめてください。',
	mailSentSameComputer:
		'リンクは、Mawok を使っているこの PC で開いてください。ほかの機器で開くと、この PC を登録できません。',
	signIn: 'サインインする',
	linkUnusableTitle: 'リンクが使えません',
	linkUnusable: 'リンクの期限が切れたか、もう使われています。サインインをやり直してください。',
	signedInAs: (email: string) => `${email} でサインインしています。`,
	signOut: 'サインアウト',
	linkTitle: 'PC を登録',
	linkConfirm: (name: string) =>
		`「${name}」をこのアカウントに登録します。登録した PC の Mawok は、アカウントのクレジットで AI アクションを使えます。`,
	approve: 'この PC を登録',
	linkInvalidTitle: 'このページは開けません',
	linkInvalid: 'Mawok の設定の「アクション」で「サインイン」を押して、もう一度開いてください。',
	buyTitle: 'クレジットを購入',
	// 価格は本番の Stripe の Price と、紹介・規約類に合わせる。
	confirmTitle: 'お申し込み内容の最終確認',
	confirmItemLabel: '買うもの',
	confirmItem: 'Mawok の AI アクションのクレジット（期限なし）',
	confirmPriceLabel: '価格',
	confirmPrice: '300 円（税込み）',
	confirmPaymentLabel: '支払い',
	confirmPayment: {
		domestic: '1 回だけの支払いで、自動の更新はありません。次の画面 (Stripe) でカードで払います。',
		overseas:
			'1 回だけの支払いで、自動の更新はありません。次の画面で払い方を選びます。後払いの払い方では、払う時期はその払い方の定めによります。販売と決済は Link (Sold through Link, LLC) が代わりに行い、カードの明細には「LINK.COM*」と出ます。お住まいの国の通貨に換えた額で表示されることがあります。'
	} as Record<SaleRegion, string>,
	confirmDeliveryLabel: '提供の時期',
	confirmDelivery: '支払いが済むとすぐ、このアカウントにクレジットが付きます。',
	confirmRefundLabel: '返金',
	confirmRefund: {
		domestic: (tokushoho: string) =>
			`購入後の返金は、原則としてできません。例外は[特定商取引法に基づく表記](${tokushoho})のとおりです。`,
		overseas: (tokushoho: string) =>
			`購入後の返金は、原則としてできません。例外は[特定商取引法に基づく表記](${tokushoho})のとおりです。ただし Link が代わりに売った購入は、購入から60 日以内は [Link の返金ポリシー](${LINK_REFUND_POLICY})が優先し、Link が返金することがあります。`
	} as Record<SaleRegion, (tokushoho: string) => string>,
	buyConsent: '{terms}・{privacy}・{conditions}に同意のうえ、進んでください。',
	confirmButton: '申し込みを確定して支払いへ',
	backToPricing: '料金ページへ戻る',
	checkoutNote: (tokushoho: string) =>
		`支払いが済むとすぐ、Mawok のアカウントにクレジットが付きます。購入後の返金は、原則としてできません。詳しくは[特定商取引法に基づく表記](${tokushoho})をご覧ください。`,
	notForSale: 'いまはクレジットを買えません。',
	buyBusy: '支払いの画面を用意しています。少ししてから、もう一度押してください。',
	checkingPurchase: '支払いを確かめています。このままお待ちください。',
	purchaseNotYet:
		'支払いをまだ確かめられていません。少ししてから確かめ直してください。買い直す前に、領収のメールが届いていないかも確かめてください。',
	checkingPro: '申し込みを確かめています。このままお待ちください。',
	proNotYet: '申し込みをまだ確かめられていません。少ししてから確かめ直してください。',
	checkAgain: 'もう一度確かめる',
	bought: 'クレジットを購入しました。Mawok の設定に戻ると、残りに反映されます。',
	proTitle: 'Mawok Pro',
	proUnavailable: 'いまは Pro を申し込めません。',
	proSubscribe: 'Pro の料金を見る',
	proItem: (plan: 'monthly' | 'yearly') =>
		`Mawok Pro（${plan === 'yearly' ? '年額' : '月額'}）。解約するまで、${plan === 'yearly' ? '1 年' : '1 か月'}ごとに自動で更新します。`,
	proPrice: (plan: 'monthly' | 'yearly'): string =>
		plan === 'yearly' ? '4,800 円/年（税込み）' : '480 円/月（税込み）',
	proPayment: (
		plan: 'monthly' | 'yearly',
		trial: boolean,
		region: SaleRegion,
		firstPaymentDate: string,
		trialDays: number
	) => {
		const amount = plan === 'yearly' ? '4,800 円' : '480 円';
		const interval = plan === 'yearly' ? '1 年' : '1 か月';
		const payment = trial
			? `${firstPaymentDate} に最初の ${amount}を支払い、その後は ${interval}ごとに同じ額を支払います。それまでの ${trialDays} 日間は無料で、${firstPaymentDate} より前に解約すれば、支払いは生じません。`
			: `申し込みのときに最初の ${amount}を支払い、その後は ${interval}ごとに同じ額を支払います。`;
		return region === 'domestic'
			? `${payment}次の画面 (Stripe) で${trial ? 'カードを登録します。' : 'カードで払います。'}`
			: `${payment}次の画面で払い方を選びます。販売と決済は Link (Sold through Link, LLC) が代わりに行い、カードの明細には「LINK.COM*」と出ます。お住まいの国の通貨に換えた額で表示されることがあります。`;
	},
	proDelivery: (trial: boolean): string =>
		trial
			? '申し込みが済むとすぐ、このアカウントで Pro を使えます。毎月の AI アクションのクレジットは、試用の間は付かず、最初の支払いの後から付きます。'
			: '支払いが済むとすぐ、このアカウントで Pro を使えます。',
	japanTime: (date: string) => `${date} (日本時間)`,
	proCancelLabel: '解約と返金',
	proCancel: {
		domestic: (tokushoho: string) =>
			`解約はアカウントのページの「支払いを管理する」からいつでもできます。次の更新日より前に解約すれば、次の期間の請求はありません。解約後も、支払い済みの期間の終わりまで Pro を使えます。支払い済みの期間は返金できません (こちらの誤りによる請求などを除きます。詳しくは[特定商取引法に基づく表記](${tokushoho}))。`,
		overseas: (tokushoho: string) =>
			`解約はアカウントのページの「支払いを管理する」からいつでもできます。次の更新日より前に解約すれば、次の期間の請求はありません。解約後も、支払い済みの期間の終わりまで Pro を使えます。支払い済みの期間は返金できません (こちらの誤りによる請求などを除きます。詳しくは[特定商取引法に基づく表記](${tokushoho}))。購入から 60 日以内は、[Link の返金ポリシー](${LINK_REFUND_POLICY})で返金されることがあります。`
	} as Record<SaleRegion, (tokushoho: string) => string>,
	proCheckoutNote:
		'解約するまで自動で更新します。解約は Mawok のアカウントのページからでき、支払い済みの期間の終わりまで使えます。支払い済みの期間は、こちらの誤りによる請求などを除き、返金できません。',
	proUntil: (plan: 'monthly' | 'yearly', date: string) =>
		`Pro（${plan === 'yearly' ? '年額' : '月額'}）: ${date} に自動で更新されます。`,
	proCanceledUntil: (plan: 'monthly' | 'yearly', date: string) =>
		`Pro（${plan === 'yearly' ? '年額' : '月額'}）: ${date} まで使えます（更新されません）。`,
	proTrialCanceledUntil: (date: string) => `試用は ${date} までです。課金はされません。`,
	proTrialUntil: (date: string) =>
		`${date} から課金が始まります。止めるときは「支払いを管理する」から解約してください。`,
	manageBilling: '支払いを管理する',
	accountTitle: 'アカウント',
	balance: (percent: number) => `AI アクションのクレジット: 残り ${percent}%`,
	noBalance: 'AI アクションのクレジットはありません。',
	appsTitle: '登録している PC',
	appsNone: '登録している PC はありません。',
	appLinkedAt: (name: string, date: string) => `${name}（${date} に登録）`,
	unlink: '登録を解除',
	tooManyConnectsTitle: 'しばらくお待ちください',
	tooManyConnects:
		'PC を登録しようとした回数が多すぎます。1 分ほどしてから、Mawok の設定でサインインし直してください。',
	about: 'Mawok について',
	terms: '利用規約',
	privacy: 'プライバシーポリシー',
	tokushoho: '特定商取引法に基づく表記',
	conditions: '購入の条件',
	mailSubject: 'Mawok にサインイン',
	mailBody: (link: string, minutes: number, linking: boolean) =>
		[
			'Mawok のアカウントにサインインするには、次のリンクを開いてください。',
			...(linking ? ['PC を登録するには、Mawok を使っている PC で開いてください。'] : []),
			'',
			link,
			'',
			`リンクは ${minutes} 分で切れます。心当たりが無ければ、このメールは無視してください。`
		].join('\n')
};

const en: typeof ja = {
	signInTitle: 'Sign in',
	signInHeading: 'Sign in to Mawok',
	signInLead: 'We will email you a sign-in link.',
	signInWithGoogle: 'Sign in with Google',
	signInWithApple: 'Sign in with Apple',
	signInWithEmail: 'Or we can email you a sign-in link.',
	signInConsent:
		'By signing in, you agree to the {terms} and the {privacy}, including providing your personal information to businesses in the United States.',
	googleFailed: "We couldn't sign you in with Google. Please try again.",
	googleUnconfirmed:
		"We can't confirm who owns the email address of this Google account. Please sign in with a link sent to your email address.",
	googleConflict:
		'Another Google account is already linked to the account for this email address. Sign in with that Google account or with a link sent to your email address.',
	appleFailed: "We couldn't sign you in with Apple. Please try again.",
	appleConflict:
		'Another Apple Account is already linked to the account for this email address. Sign in with that Apple Account or with a link sent to your email address.',
	email: 'Email address',
	sendLink: 'Send link',
	invalidEmail: 'Check your email address.',
	tooManyLinks: 'Too many links have been sent. Please try again later.',
	mailSentTitle: 'Check your email',
	mailSent: (email: string, minutes: number) =>
		`Open the link we sent to ${email}. The link expires in ${minutes} minutes.`,
	mailSentHint: "If it doesn't arrive, check your spam folder.",
	mailSentSameComputer:
		'Open the link on this PC, where you use Mawok. If you open it on another device, this PC cannot be linked.',
	signIn: 'Sign in',
	linkUnusableTitle: 'This link cannot be used',
	linkUnusable: 'The link has expired or has already been used. Please sign in again.',
	signedInAs: (email: string) => `Signed in as ${email}.`,
	signOut: 'Sign out',
	linkTitle: 'Link a PC',
	linkConfirm: (name: string) =>
		`Link "${name}" to this account. Mawok on a linked PC can use this account's credit for AI actions.`,
	approve: 'Link this PC',
	linkInvalidTitle: 'This page cannot be opened',
	linkInvalid: 'In Mawok settings, open Actions and click Sign in to open it again.',
	buyTitle: 'Buy credits',
	confirmTitle: 'Review your order',
	confirmItemLabel: 'What you buy',
	confirmItem: 'Mawok AI action credit (does not expire)',
	confirmPriceLabel: 'Price',
	confirmPrice: '300 yen (tax included)',
	confirmPaymentLabel: 'Payment',
	confirmPayment: {
		domestic:
			'This is a one-time payment and does not renew automatically. You pay by card on the next page (Stripe).',
		overseas:
			'This is a one-time payment and does not renew automatically. You choose how to pay on the next page. With a pay-later method, you pay when that method requires. The sale and payment are handled on our behalf by Link (Sold through Link, LLC), and your card statement shows "LINK.COM*". The amount may be shown in your local currency.'
	},
	confirmDeliveryLabel: 'When it is provided',
	confirmDelivery: 'The credit is added to this account as soon as the payment is complete.',
	confirmRefundLabel: 'Refunds',
	confirmRefund: {
		domestic: (tokushoho: string) =>
			`Purchases are generally non-refundable. For exceptions, see the [Specified Commercial Transactions Act notice](${tokushoho}).`,
		overseas: (tokushoho: string) =>
			`Purchases are generally non-refundable. For exceptions, see the [Specified Commercial Transactions Act notice](${tokushoho}). For a purchase sold through Link, however, [Link's refund policy](${LINK_REFUND_POLICY}) takes precedence within 60 days of purchase, and Link may issue a refund.`
	},
	buyConsent: 'By continuing, you agree to the {terms}, the {privacy}, and the {conditions}.',
	confirmButton: 'Confirm and continue to payment',
	backToPricing: 'Back to pricing',
	checkoutNote: (tokushoho: string) =>
		`The credit is added to your Mawok account as soon as the payment is complete. Purchases are generally non-refundable. For details, see the [Specified Commercial Transactions Act notice](${tokushoho}).`,
	notForSale: 'AI action credit is not available for purchase right now.',
	buyBusy: 'Preparing the payment page. Please try again in a moment.',
	checkingPurchase: 'Confirming your payment. Please wait.',
	purchaseNotYet:
		"We couldn't confirm your payment yet. Please check again in a moment. Before buying again, check whether a receipt email has arrived.",
	checkingPro: 'Confirming your subscription. Please wait.',
	proNotYet: "We couldn't confirm your subscription yet. Please check again in a moment.",
	checkAgain: 'Check again',
	bought:
		'AI action credit has been added. Go back to Mawok settings to see your remaining credit.',
	proTitle: 'Mawok Pro',
	proUnavailable: 'Pro is not available right now.',
	proSubscribe: 'See Pro pricing',
	proItem: (plan: 'monthly' | 'yearly') =>
		`Mawok Pro (${plan}). It renews automatically every ${plan === 'yearly' ? 'year' : 'month'} until you cancel.`,
	proPrice: (plan: 'monthly' | 'yearly') =>
		plan === 'yearly' ? '4,800 yen/year (tax included)' : '480 yen/month (tax included)',
	proPayment: (
		plan: 'monthly' | 'yearly',
		trial: boolean,
		region: SaleRegion,
		firstPaymentDate: string,
		trialDays: number
	) => {
		const amount = plan === 'yearly' ? '4,800 yen' : '480 yen';
		const interval = plan === 'yearly' ? 'year' : 'month';
		const payment = trial
			? `Your first payment of ${amount} is due on ${firstPaymentDate}, followed by payments of the same amount every ${interval}. The ${trialDays} days until then are free: cancel before ${firstPaymentDate} and you will not be charged. `
			: `You pay the first ${amount} when you subscribe, then the same amount every ${interval}. `;
		return region === 'domestic'
			? `${payment}${trial ? 'Register your card' : 'Pay by card'} on the next page (Stripe).`
			: `${payment}Choose how to pay on the next page. The sale and payment are handled on our behalf by Link (Sold through Link, LLC), and your card statement shows "LINK.COM*". The amount may be shown in your local currency.`;
	},
	proDelivery: (trial: boolean) =>
		trial
			? 'Pro is available on this account as soon as you subscribe. Monthly AI action credit is not added during the trial; it begins after your first payment.'
			: 'Pro is available on this account as soon as payment is complete.',
	japanTime: (date: string) => `${date} (Japan time)`,
	proCancelLabel: 'Cancellation and refunds',
	proCancel: {
		domestic: (tokushoho: string) =>
			`You can cancel at any time from Manage billing on your account page. Cancel before the next renewal date and you will not be charged for the next period. After cancellation, you can keep using Pro until the end of the paid period. Paid periods are not refunded, except in cases such as billing errors on our side (see the [Specified Commercial Transactions Act notice](${tokushoho})).`,
		overseas: (tokushoho: string) =>
			`You can cancel at any time from Manage billing on your account page. Cancel before the next renewal date and you will not be charged for the next period. After cancellation, you can keep using Pro until the end of the paid period. Paid periods are not refunded, except in cases such as billing errors on our side (see the [Specified Commercial Transactions Act notice](${tokushoho})). Within 60 days of purchase, you may get a refund under [Link's refund policy](${LINK_REFUND_POLICY}).`
	},
	proCheckoutNote:
		'It renews automatically until you cancel. You can cancel from your Mawok account page and continue using it until the end of the paid period. Paid periods are not refunded, except in cases such as billing errors on our side.',
	proUntil: (plan: 'monthly' | 'yearly', date: string) =>
		`Pro (${plan}): renews automatically on ${date}.`,
	proCanceledUntil: (plan: 'monthly' | 'yearly', date: string) =>
		`Pro (${plan}): available until ${date}; it will not renew.`,
	proTrialCanceledUntil: (date: string) =>
		`Your trial lasts until ${date}. You will not be charged.`,
	proTrialUntil: (date: string) =>
		`Billing starts on ${date}. To stop it, cancel through “Manage billing”.`,
	manageBilling: 'Manage billing',
	accountTitle: 'Account',
	balance: (percent: number) => `AI action credit: ${percent}% left`,
	noBalance: 'No AI action credit.',
	appsTitle: 'Linked PCs',
	appsNone: 'No PCs are linked.',
	appLinkedAt: (name: string, date: string) => `${name} (linked on ${date})`,
	unlink: 'Unlink',
	tooManyConnectsTitle: 'Please wait',
	tooManyConnects: 'Too many link attempts. Wait a minute, then sign in again from Mawok settings.',
	about: 'About Mawok',
	terms: 'Terms of Use',
	privacy: 'Privacy Policy',
	tokushoho: 'Specified Commercial Transactions Act notice',
	conditions: 'purchase conditions',
	mailSubject: 'Sign in to Mawok',
	mailBody: (link: string, minutes: number, linking: boolean) =>
		[
			'Open the following link to sign in to your Mawok account.',
			...(linking ? ['To link this PC, open the link on the PC where you use Mawok.'] : []),
			'',
			link,
			'',
			`The link expires in ${minutes} minutes. If you didn't request this, you can ignore this email.`
		].join('\n')
};

export const messages: Record<Lang, typeof ja> = { ja, en };
