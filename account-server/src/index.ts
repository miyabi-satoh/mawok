/**
 * Mawok の窓口 (→ docs/account-server.md「窓口（mawok.amiiby.com）」)。
 *
 * - `/v1/links/token`: Mawok を結ぶときに届けたコードを、アプリ用のトークンに替える。
 * - `/v1/ai`・`/v1/balance`・`/v1/token`: アプリ用のトークンで呼ぶ、中継・残高・サインアウト。
 * - `/v1/sync`: アプリ用のトークンで呼ぶ、Pro の設定と履歴の同期。
 * - `/v1/stripe/webhook`: Stripe からの支払いの知らせ (処理は src/webhook.ts)。
 * - `/account/`: 人が開く画面 (サインイン・Mawok を結ぶ・買う)。
 * - それ以外: 紹介と規約類の静的なページ (wrangler.jsonc の assets)。
 */
import { Hono, type Context } from 'hono';
import { csrf } from 'hono/csrf';
import { parsePrompt, relay } from './ai';
import { balance, charge, grantFreeStatement, proOf, topUp } from './credits';
import { messages, resolveLang, type Lang } from './i18n';
import { isProPlan, pricing, type ProPlan } from './pricing';
import { sendMail } from './mail';
import {
	approvePage,
	checkingPurchasePage,
	confirmPage,
	proConfirmPage,
	confirmSignInPage,
	homePage,
	LEGAL_PAGES,
	mailSentPage,
	messagePage,
	signInPage,
	type LinkedApp,
	type LinkRequest,
	type SaleRegion
} from './pages';
import { appleConfig, finishAppleSignIn, startAppleSignIn } from './apple';
import { finishGoogleSignIn, googleConfig, startGoogleSignIn } from './google';
import {
	createProCheckoutSession,
	billingPortalUrl,
	expireCheckoutSession,
	createCheckoutSession,
	proForSale,
	StripeError,
	stripeConfig,
	type StripeConfig,
	usesManagedPayments,
	verifyWebhook
} from './stripe';
import { currentAccount, endSession, startSession } from './session';
import { forgetOldRecords, handleStripeEvent, markStripeEvent } from './webhook';
import {
	getSync,
	hasSyncPro,
	purgeSync,
	putSync,
	resetSync,
	SYNC_REQUEST_BYTES,
	syncQuery
} from './sync';
import {
	isEmail,
	normalizeEmail,
	formString,
	now,
	randomHex,
	safeNext,
	ACCOUNT,
	ACCOUNT_HOME,
	sha256Hex
} from './util';

/** 「この Mawok と結ぶ」で作るコードの期限。ブラウザが Mawok へ戻ってすぐ替えるので短く。 */
const LINK_CODE_TTL = 300;
/** メールのリンクの期限。メールが少し遅れて届いても間に合い、漏れたリンクを使える時間は短く。 */
const EMAIL_LOGIN_TTL = 15 * 60;
/** 同じアドレスへ1時間に送るリンクの上限。他人のアドレスへ送りつけるのに使われないように。 */
const EMAIL_LOGINS_PER_HOUR = 5;
/** 上の上限を数える幅。上限を「1時間に何通」で決めているので、その1時間。 */
const EMAIL_LOGIN_WINDOW = 3600;
/** 支払いから戻った先で、残高が付くのを自動で確かめ直す回数 (3秒おき)。webhook は数秒で届くことが多い。 */
const PURCHASE_CHECKS = 10;
/**
 * 支払いの画面の期限。Stripe が受け付ける最も短い30分に、同じ予約で頼み直せる5分を足す
 * (Stripe は頼むたびに期限が30分以上先かを確かめる)。
 */
const CHECKOUT_TTL = 35 * 60;
/**
 * 中継の最中とみなす長さ。Gemini を待つ上限 (src/ai.ts) より長くする。
 * Worker が途中で止まって印が残っても、これを過ぎれば次の中継を受ける。
 */
const IN_FLIGHT_TTL = 120;

type App = { Bindings: Env };
// `/account` と `/account/` を同じ画面にする (紹介のページは末尾に `/` を付けてリンクする)。
export const app = new Hono<App>({ strict: false });

// 値付けの値が欠けていれば、どの入口も DB に書く前に止める (→ docs/account-server.md「値付けの値」)。
// サインインのリンクを使ってから 500 になるような、やり直せない途中で止まらないように。
app.use(async (c, next) => {
	pricing(c.env);
	await next();
});

/**
 * 上限に当たったら true。既定は送り主 (IP) ごとに数え、`key` を渡せばそれごと (アカウントごとなど) に数える。
 * D1 の書き込みの枠やメールを使い切られないように。
 * 数え方はおおよそ (Workers の Rate Limiting)。正確さより、止めることを取る。
 */
async function limited(c: Context<App>, limiter: RateLimit, key?: string): Promise<boolean> {
	const { success } = await limiter.limit({
		key: key ?? c.req.header('cf-connecting-ip') ?? 'unknown'
	});
	return !success;
}

// ---- Mawok を結ぶ ----

/**
 * 「この Mawok と結ぶ」で Mawok の待ち受けへ届けたコードを、アプリ用のトークンに替える。
 * コードは一度きりで、申し込みに付けた検証用の値と照らす。届け先の待ち受けを他のプロセスに取られても、
 * 検証用の値を持たないのでトークンに替えられないように (RFC 7636 の PKCE と同じ考え方)。
 */
app.post('/v1/links/token', async (c) => {
	if (await limited(c, c.env.LINK_LIMITER)) return c.json({ error: 'rate_limited' }, 429);
	const body = await c.req
		.json<{ code?: unknown; code_verifier?: unknown }>()
		.catch(() => ({}) as never);
	if (typeof body.code !== 'string' || typeof body.code_verifier !== 'string') {
		return c.json({ error: 'invalid_grant' }, 400);
	}
	// 照らす前に消す。違う検証用の値で試されたコードも、それきり使えないように。
	const link = await c.env.DB.prepare(
		'DELETE FROM link_codes WHERE code_hash = ? RETURNING account_id, challenge, name, expires_at'
	)
		.bind(await sha256Hex(body.code))
		.first<{ account_id: string; challenge: string; name: string; expires_at: number }>();
	if (
		!link ||
		link.expires_at <= now() ||
		(await sha256Hex(body.code_verifier)) !== link.challenge
	) {
		return c.json({ error: 'invalid_grant' }, 400);
	}
	const token = randomHex(32);
	await c.env.DB.prepare(
		'INSERT INTO app_tokens (id, token_hash, account_id, name, created_at) VALUES (?, ?, ?, ?, ?)'
	)
		.bind(randomHex(16), await sha256Hex(token), link.account_id, link.name, now())
		.run();
	return c.json({ token });
});

// ---- アプリ用のトークンで呼ぶもの ----

/** `Authorization: Bearer <トークン>` のトークン。 */
function bearerToken(c: Context<App>): string | undefined {
	return /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')?.[1];
}

/** アプリ用のトークンのアカウント。トークンが無いか、外されていれば `undefined`。 */
async function appAccount(c: Context<App>): Promise<string | undefined> {
	const token = bearerToken(c);
	if (!token) return undefined;
	const row = await c.env.DB.prepare(
		'UPDATE app_tokens SET last_used_at = ? WHERE token_hash = ? RETURNING account_id'
	)
		.bind(now(), await sha256Hex(token))
		.first<{ account_id: string }>();
	return row?.account_id;
}

/** Mawok の設定に出す残り。 */
app.get('/v1/balance', async (c) => {
	const accountId = await appAccount(c);
	if (!accountId) return c.json({ error: 'unauthorized' }, 401);
	const account = await c.env.DB.prepare('SELECT id, email FROM accounts WHERE id = ?')
		.bind(accountId)
		.first<{ id: string; email: string }>();
	const pro = await topUp(c.env, accountId);
	const { remaining, percent } = await balance(c.env, accountId);
	const { renews: _renews, ...proResponse } = pro;
	return c.json({
		account_id: account?.id,
		email: account?.email,
		remaining_percent: remaining > 0 ? percent : 0,
		pro: proResponse
	});
});

/** Mawok でのサインアウト。トークンを外す。 */
app.delete('/v1/token', async (c) => {
	const token = bearerToken(c);
	if (token) {
		await c.env.DB.prepare('DELETE FROM app_tokens WHERE token_hash = ?')
			.bind(await sha256Hex(token))
			.run();
	}
	return c.body(null, 204);
});

// ---- Pro の設定と履歴の同期 ----

/** 同期の入口の共通の認可と、アカウントごとの書き込み上限。 */
async function syncAccount(c: Context<App>): Promise<string | Response> {
	const accountId = await appAccount(c);
	if (!accountId) return c.json({ error: 'unauthorized' }, 401);
	if (await limited(c, c.env.SYNC_LIMITER, accountId))
		return c.json({ error: 'rate_limited' }, 429);
	if (!(await hasSyncPro(c.env, accountId))) return c.json({ error: 'pro_required' }, 403);
	return accountId;
}

app.get('/v1/sync', async (c) => {
	const accountId = await syncAccount(c);
	if (accountId instanceof Response) return accountId;
	const query = syncQuery({
		since: c.req.query('since'),
		limit: c.req.query('limit'),
		rebuild: c.req.query('rebuild')
	});
	if (!query) return c.json({ error: 'invalid_request' }, 400);
	return c.json(await getSync(c.env, accountId, query));
});

app.put('/v1/sync', async (c) => {
	const accountId = await syncAccount(c);
	if (accountId instanceof Response) return accountId;
	const contentLength = Number(c.req.header('content-length'));
	if (Number.isFinite(contentLength) && contentLength > SYNC_REQUEST_BYTES)
		return c.json({ error: 'too_large', limit: 'request' }, 413);
	const result = await putSync(c.env, accountId, await c.req.json().catch(() => undefined));
	if (result.ok) return c.json({ seq: result.seq, items: result.items });
	if (result.error === 'invalid_request') return c.json({ error: result.error }, 400);
	if (result.error === 'key_mismatch') return c.json({ error: result.error }, 409);
	if (result.error === 'too_large')
		return c.json({ error: result.error, limit: result.limit }, 413);
	return c.json({ error: result.error, conflicts: result.conflicts }, 409);
});

app.post('/v1/sync/reset', async (c) => {
	const accountId = await syncAccount(c);
	if (accountId instanceof Response) return accountId;
	const result = await resetSync(c.env, accountId, await c.req.json().catch(() => undefined));
	if (!result) return c.json({ error: 'invalid_request' }, 400);
	return c.json(result);
});

/**
 * AI の中継。残りがあれば Gemini へ送り、返事が届いたら使った原価を引いて、Gemini の返事をそのまま返す。
 * 返事が届かなかった回は引かない。失敗の返事でも、Gemini が使った分を返せば引く。
 */
app.post('/v1/ai', async (c) => {
	const accountId = await appAccount(c);
	if (!accountId) return c.json({ error: 'unauthorized' }, 401);
	const prompt = parsePrompt(await c.req.json().catch(() => undefined));
	if (prompt === undefined) return c.json({ error: 'bad_request' }, 400);
	if (prompt === 'too_long') return c.json({ error: 'too_long' }, 413);
	const { rates } = pricing(c.env);
	await topUp(c.env, accountId);
	const t = now();
	// 同じアカウントは同時に1件だけ。印を取ってから残りを確かめるので、並べて送って残りを超えて使わせないように。
	const owner = randomHex(16);
	const started = await c.env.DB.prepare(
		`INSERT INTO ai_in_flight (account_id, owner, started_at) VALUES (?1, ?2, ?3)
		 ON CONFLICT (account_id) DO UPDATE SET owner = ?2, started_at = ?3 WHERE started_at <= ?4`
	)
		.bind(accountId, owner, t, t - IN_FLIGHT_TTL)
		.run();
	if (started.meta.changes !== 1) return c.json({ error: 'busy' }, 409);
	const release = () =>
		c.env.DB.prepare('DELETE FROM ai_in_flight WHERE account_id = ? AND owner = ?')
			.bind(accountId, owner)
			.run();
	if ((await balance(c.env, accountId)).remaining <= 0) {
		await release();
		return c.json({ error: 'no_credit' }, 402);
	}
	// 中継・引くこと・印を外すことを1つにまとめ、waitUntil に渡す。Mawok で取り消して接続が切れても、
	// Gemini が使った分を引き、印を外すまで続けさせる (呼び出しが終わると、waitUntil に渡していない処理は打ち切られうる)。
	const work = (async () => {
		try {
			const result = await relay(c.env, prompt, rates);
			await charge(c.env, accountId, result.cost);
			return result;
		} finally {
			await release();
		}
	})();
	c.executionCtx.waitUntil(work.catch(() => {}));
	const result = await work;
	if (result.ok) return c.body(result.body, 200, { 'content-type': 'application/json' });
	// Gemini の失敗は、状態だけを Mawok へ返す (Mawok は利用者のキーで送ったときと同じく分ける)。
	return c.json({ error: 'upstream', upstream_status: result.status }, 502);
});

// ---- Stripe からの知らせ ----

/**
 * 残高を付けるのはここだけ。支払いの画面から戻った先では付けない (戻らずに閉じられることもあるため)。
 * 知らせは id で記録し、処理し終えたものは送り直されても処理し直さない。失敗したら 500 を返し、Stripe の送り直しで処理し直す。
 * どの処理も、何度行っても結果が同じになるように書く (記録する前に落ちても送り直されるため)。
 */
app.post('/v1/stripe/webhook', async (c) => {
	const config = stripeConfig(c.env);
	if (!config) return c.json({ error: 'not_found' }, 404);
	const body = await c.req.text();
	if (!(await verifyWebhook(config, body, c.req.header('stripe-signature'), now()))) {
		return c.json({ error: 'invalid_signature' }, 400);
	}
	const event = JSON.parse(body) as {
		id: string;
		type: string;
		data: { object: Record<string, unknown> };
	};
	const seen = await c.env.DB.prepare('SELECT status FROM stripe_events WHERE id = ?')
		.bind(event.id)
		.first<{ status: string }>();
	if (seen?.status === 'done') return c.json({ received: true });
	await c.env.DB.prepare(
		`INSERT INTO stripe_events (id, type, status, received_at, updated_at) VALUES (?1, ?2, 'received', ?3, ?3)
		 ON CONFLICT (id) DO UPDATE SET status = 'received', updated_at = ?3`
	)
		.bind(event.id, event.type, now())
		.run();
	try {
		const outcome = await handleStripeEvent(c.env, config, event.type, event.data.object);
		await markStripeEvent(c.env, event.id, outcome === 'failed' ? 'failed' : 'done');
	} catch (e) {
		await markStripeEvent(c.env, event.id, 'failed');
		throw e;
	}
	// 片付けは次の知らせのときにもやり直せるので、失敗しても知らせは受け取ったことにする。
	await forgetOldRecords(c.env).catch((e) => console.error('failed to forget old records', e));
	return c.json({ received: true });
});

// ---- 人が開く画面 ----

const accountApp = new Hono<App>();
accountApp.use(
	csrf({
		// Apple はサインインの結果を、Apple のサイトから戻り先へ POST で送る。送り元が `null` で届くこともあるので、
		// 戻り先だけは送り元を見ず、state の照らし合わせで守る (→ src/apple.ts)。
		origin: (origin, c) => origin === new URL(c.req.url).origin || c.req.path === APPLE_CALLBACK
	})
);

accountApp.get('/', async (c) => {
	const lang = resolveLang(c);
	const account = await currentAccount(c);
	if (!account) return c.html(signIn(c, lang, ACCOUNT_HOME));
	const { results: apps } = await c.env.DB.prepare(
		`SELECT id, coalesce(name, 'Mawok') AS name, created_at AS createdAt FROM app_tokens
		 WHERE account_id = ? ORDER BY created_at`
	)
		.bind(account.id)
		.all<LinkedApp>();
	const pro = await proOf(c.env, account.id);
	return c.html(
		homePage(lang, account.email, await balance(c.env, account.id), apps, saleRegion(c), {
			pro,
			billing: stripeConfig(c.env) !== undefined,
			bought: c.req.query('bought') === '1'
		})
	);
});

/** 窓口の画面から、結んだ Mawok を外す。外した Mawok は、次に使うときにサインインし直しになる。 */
accountApp.post('/apps/unlink', async (c) => {
	const lang = resolveLang(c);
	const account = await currentAccount(c);
	if (!account) return c.html(signIn(c, lang, ACCOUNT_HOME), 401);
	const form = await c.req.parseBody();
	await c.env.DB.prepare('DELETE FROM app_tokens WHERE id = ? AND account_id = ?')
		.bind(formString(form, 'id') ?? '', account.id)
		.run();
	return c.redirect(ACCOUNT_HOME, 303);
});

accountApp.post('/login/email', async (c) => {
	const lang = resolveLang(c);
	const form = await c.req.parseBody();
	const next = safeNext(formString(form, 'next'));
	const email = normalizeEmail(formString(form, 'email') ?? '');
	if (!isEmail(email)) {
		return c.html(signIn(c, lang, next, messages[lang].invalidEmail), 400);
	}
	if (await limited(c, c.env.EMAIL_LIMITER)) {
		return c.html(signIn(c, lang, next, messages[lang].tooManyLinks), 429);
	}
	const t = now();
	const token = randomHex(32);
	// 数えるのと足すのを1つの文にする。別々だと、同時に送られたときに上限を超える。
	const [, inserted] = await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM email_logins WHERE created_at <= ?').bind(t - EMAIL_LOGIN_WINDOW),
		c.env.DB.prepare(
			`INSERT INTO email_logins (token_hash, email, next, expires_at, created_at)
			 SELECT ?1, ?2, ?3, ?4, ?5
			 WHERE (SELECT count(*) FROM email_logins WHERE email = ?2 AND created_at > ?6) < ?7`
		).bind(
			await sha256Hex(token),
			email,
			next,
			t + EMAIL_LOGIN_TTL,
			t,
			t - EMAIL_LOGIN_WINDOW,
			EMAIL_LOGINS_PER_HOUR
		)
	]);
	if (inserted.meta.changes === 0) {
		return c.html(signIn(c, lang, next, messages[lang].tooManyLinks), 429);
	}
	// Mawok を結ぶ途中なら、リンクを同じパソコンで開くよう添える (結ぶとブラウザを 127.0.0.1 へ戻すため)。
	const linking = next.startsWith(`${ACCOUNT}/link?`);
	// 別のブラウザで開いても同じ言語になるよう、リンクに言語を付ける。
	await sendMail(
		c.env,
		email,
		messages[lang].mailSubject,
		messages[lang].mailBody(
			`${new URL(c.req.url).origin}${ACCOUNT}/login/email?token=${token}&lang=${lang}`,
			EMAIL_LOGIN_TTL / 60,
			linking
		)
	);
	return c.html(mailSentPage(lang, email, EMAIL_LOGIN_TTL / 60, linking));
});

// メールのリンクを開いただけではサインインしない。メールのサービスがリンクを先に開いて確かめることがあり、
// そこで1回きりのトークンを使い切らないように。
accountApp.get('/login/email', (c) =>
	c.html(confirmSignInPage(resolveLang(c), c.req.query('token') ?? ''))
);

accountApp.post('/login/email/verify', async (c) => {
	const lang = resolveLang(c);
	const form = await c.req.parseBody();
	const token = formString(form, 'token') ?? '';
	const t = now();
	const login = await c.env.DB.prepare(
		`UPDATE email_logins SET used_at = ?
		 WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
		 RETURNING email, next`
	)
		.bind(t, await sha256Hex(token), t)
		.first<{ email: string; next: string }>();
	if (!login) {
		return c.html(
			messagePage(lang, messages[lang].linkUnusableTitle, messages[lang].linkUnusable),
			400
		);
	}
	const account = await upsertAccount(c.env, login.email, t).first<{ id: string }>();
	await signedIn(c, account!.id);
	return c.redirect(safeNext(login.next), 303);
});

/** サインインが済んだ。無料の分をまだ付けていなければ、ここで付ける (→ src/credits.ts)。 */
async function signedIn(c: Context<App>, accountId: string) {
	await startSession(c, accountId);
	await grantFreeStatement(c.env, accountId).run();
}

// ---- Google でサインイン ----

accountApp.get('/login/google', async (c) => {
	const config = googleConfig(c.env);
	if (!config) return c.notFound();
	const next = safeNext(c.req.query('next'));
	return c.redirect(await startGoogleSignIn(c, config, googleRedirectUri(c), next), 303);
});

accountApp.get('/login/google/callback', async (c) => {
	const lang = resolveLang(c);
	const config = googleConfig(c.env);
	if (!config) return c.notFound();
	const user = await finishGoogleSignIn(c, config, googleRedirectUri(c), now());
	if ('failure' in user) {
		const error =
			user.failure === 'unconfirmed_email'
				? messages[lang].googleUnconfirmed
				: messages[lang].googleFailed;
		return c.html(signIn(c, lang, user.next, error), 400);
	}
	return externalSignedIn(c, lang, 'google', user, messages[lang].googleConflict);
});

function googleRedirectUri(c: Context<App>): string {
	return `${new URL(c.req.url).origin}${ACCOUNT}/login/google/callback`;
}

// ---- Apple でサインイン ----

const APPLE_CALLBACK = `${ACCOUNT}/login/apple/callback`;

accountApp.get('/login/apple', (c) => {
	const config = appleConfig(c.env);
	if (!config) return c.notFound();
	const next = safeNext(c.req.query('next'));
	return c.redirect(startAppleSignIn(c, config, appleRedirectUri(c), next, resolveLang(c)), 303);
});

accountApp.post('/login/apple/callback', async (c) => {
	const config = appleConfig(c.env);
	if (!config) return c.notFound();
	const user = await finishAppleSignIn(c, config, appleRedirectUri(c), now());
	const lang = user.lang ?? resolveLang(c);
	if ('failure' in user) {
		// 取り消したときは、何も言わずにサインインの画面へ戻す。
		return user.failure === 'cancelled'
			? c.html(signIn(c, lang, user.next))
			: c.html(signIn(c, lang, user.next, messages[lang].appleFailed), 400);
	}
	return externalSignedIn(c, lang, 'apple', user, messages[lang].appleConflict);
});

function appleRedirectUri(c: Context<App>): string {
	return `${new URL(c.req.url).origin}${APPLE_CALLBACK}`;
}

type Provider = 'google' | 'apple';

/** 外部のサインインで確かめたアカウントでサインインし、元の画面へ戻す。結べなければ `conflict` を出す。 */
async function externalSignedIn(
	c: Context<App>,
	lang: Lang,
	provider: Provider,
	user: { subject: string; email: string; next: string },
	conflict: string
) {
	const accountId = await externalAccount(c.env, provider, user.subject, user.email);
	if (!accountId) return c.html(signIn(c, lang, user.next, conflict), 409);
	await signedIn(c, accountId);
	return c.redirect(safeNext(user.next), 303);
}

/**
 * 外部のサインインのアカウントに結ぶ窓口のアカウント。確かめ済みのメールだけを渡す。
 * 識別子 (sub) → 同じメールアドレスのアカウント → 新しいアカウント、の順で探す。
 * 同じメールのアカウントに、同じ方法の別のアカウントがもう結ばれていれば結ばず、`undefined` を返す。
 */
async function externalAccount(
	env: Env,
	provider: Provider,
	subject: string,
	email: string
): Promise<string | undefined> {
	const linked = await identity(env, provider, subject);
	if (linked) return linked.account_id;
	const t = now();
	const [account] = await env.DB.batch<{ id: string }>([
		// メールのリンクと同じく、同じアドレスなら同じアカウント。
		upsertAccount(env, email, t),
		env.DB.prepare(
			`INSERT INTO identities (provider, subject, account_id, created_at)
			 SELECT ?1, ?2, id, ?3 FROM accounts
			 WHERE email = ?4
			   AND NOT EXISTS (SELECT 1 FROM identities
			                   WHERE provider = ?1 AND account_id = accounts.id)
			 ON CONFLICT DO NOTHING`
		).bind(provider, subject, t, email)
	]);
	const id = account.results[0].id;
	return (await identity(env, provider, subject))?.account_id === id ? id : undefined;
}

function identity(env: Env, provider: Provider, subject: string) {
	return env.DB.prepare('SELECT account_id FROM identities WHERE provider = ? AND subject = ?')
		.bind(provider, subject)
		.first<{ account_id: string }>();
}

/** メールアドレスのアカウントを作るか、あればそれを返す文。どの方法で入っても、同じアドレスなら同じアカウント。 */
function upsertAccount(env: Env, email: string, t: number) {
	return env.DB.prepare(
		`INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)
		 ON CONFLICT (email) DO UPDATE SET email = excluded.email
		 RETURNING id`
	).bind(randomHex(16), email, t);
}

/** サインインの画面。Google・Apple でサインインできるときは、そのボタンも出す。 */
function signIn(c: Context<App>, lang: Lang, next: string, error?: string) {
	return signInPage(lang, next, {
		error,
		google: googleConfig(c.env) !== undefined,
		apple: appleConfig(c.env) !== undefined
	});
}

accountApp.post('/logout', async (c) => {
	const form = await c.req.parseBody();
	await endSession(c);
	return c.redirect(safeNext(formString(form, 'next')), 303);
});

// ---- Mawok を結ぶ ----

/** Mawok が申し込みに付けた値を読む。形が違えば `undefined` (Mawok の設定から開き直してもらう)。 */
function linkRequest(get: (key: string) => string | undefined): LinkRequest | undefined {
	const port = Number(get('port'));
	const state = get('state') ?? '';
	const challenge = get('challenge') ?? '';
	if (!Number.isInteger(port) || port < 1024 || port > 65535) return undefined;
	if (!/^[0-9a-f]{32}$/.test(state) || !/^[0-9a-f]{64}$/.test(challenge)) return undefined;
	// 名前は窓口の画面に出すだけ。制御文字を除き、長すぎれば切る。
	const name = [...(get('name') ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim()]
		.slice(0, 64)
		.join('');
	return { port, state, challenge, name: name || 'Mawok' };
}

function linkQuery(link: LinkRequest): string {
	return new URLSearchParams({
		port: String(link.port),
		state: link.state,
		challenge: link.challenge,
		name: link.name
	}).toString();
}

accountApp.get('/link', async (c) => {
	const lang = resolveLang(c);
	const link = linkRequest((key) => c.req.query(key));
	if (!link) return c.html(linkInvalidPage(lang), 400);
	const account = await currentAccount(c);
	if (!account) return c.html(signIn(c, lang, `${ACCOUNT}/link?${linkQuery(link)}`));
	return c.html(approvePage(lang, account.email, link, `${ACCOUNT}/link?${linkQuery(link)}`));
});

/**
 * 結ぶ。一度きりのコードを作り、ブラウザを Mawok の待ち受け (同じ PC の 127.0.0.1) へ戻す。
 * 戻る先が押した人の PC なので、他人から届いたリンクで押しても、コードはリンクを作った人の Mawok へ届かない。
 */
accountApp.post('/link', async (c) => {
	const lang = resolveLang(c);
	const form = await c.req.parseBody();
	const link = linkRequest((key) => formString(form, key));
	if (!link) return c.html(linkInvalidPage(lang), 400);
	const account = await currentAccount(c);
	if (!account) return c.html(signIn(c, lang, `${ACCOUNT}/link?${linkQuery(link)}`), 401);
	if (await limited(c, c.env.CODE_LIMITER, account.id)) {
		return c.html(
			messagePage(lang, messages[lang].tooManyConnectsTitle, messages[lang].tooManyConnects),
			429
		);
	}
	const code = randomHex(32);
	const t = now();
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM link_codes WHERE expires_at <= ?').bind(t),
		c.env.DB.prepare(
			`INSERT INTO link_codes (code_hash, account_id, challenge, name, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).bind(await sha256Hex(code), account.id, link.challenge, link.name, t + LINK_CODE_TTL, t)
	]);
	const back = new URLSearchParams({ code, state: link.state });
	return c.redirect(`http://127.0.0.1:${link.port}/callback?${back}`, 303);
});

function linkInvalidPage(lang: Lang) {
	return messagePage(lang, messages[lang].linkInvalidTitle, messages[lang].linkInvalid);
}

// ---- 残高を買う ----

/** アクセス元の IP の国 (Cloudflare が付ける)。手元で動かすときなど、分からなければ `undefined`。 */
function buyerCountry(c: Context<App>): string | undefined {
	return c.req.raw.cf?.country as string | undefined;
}

/** 買うボタンを出すか、出すならどちらの売り方の説明を添えるか。 */
function saleRegion(c: Context<App>): SaleRegion | undefined {
	if (!stripeConfig(c.env)) return undefined;
	return usesManagedPayments(buyerCountry(c)) ? 'overseas' : 'domestic';
}

function notForSalePage(lang: Lang) {
	return messagePage(lang, messages[lang].buyTitle, messages[lang].notForSale);
}
function proUnavailablePage(lang: Lang) {
	return messagePage(lang, messages[lang].proTitle, messages[lang].proUnavailable);
}

/** 料金ページから来る、支払いの直前の最終確認画面。 */
accountApp.get('/buy', async (c) => {
	const lang = resolveLang(c);
	const account = await currentAccount(c);
	const plan = c.req.query('plan');
	// サインインの後に同じ最終確認へ戻れるよう、選んだプランを戻り先に残す。
	if (!account)
		return c.html(
			signIn(c, lang, isProPlan(plan) ? `${ACCOUNT}/buy?plan=${plan}` : `${ACCOUNT}/buy`)
		);
	if (isProPlan(plan)) {
		const config = stripeConfig(c.env);
		if (!config || !proForSale(config)) return c.html(proUnavailablePage(lang), 404);
		const pro = await proOf(c.env, account.id);
		if (pro.active) return c.redirect(ACCOUNT_HOME, 303);
		const trial = !(await hadSubscription(c.env, account.id));
		return c.html(
			proConfirmPage(lang, account.email, plan, saleRegion(c)!, {
				trial,
				now: now()
			})
		);
	}
	const region = saleRegion(c);
	if (!region) return c.html(notForSalePage(lang), 404);
	return c.html(confirmPage(lang, account.email, region));
});

/** 最終確認の画面から、支払いの画面へ送る。買い終えたらアカウントの画面へ戻す。 */
accountApp.post('/buy', async (c) => {
	const lang = resolveLang(c);
	const form = await c.req.parseBody();
	const next = safeNext(formString(form, 'next'));
	const proPlan = formString(form, 'plan');
	const account = await currentAccount(c);
	if (!account) return c.html(signIn(c, lang, next), 401);
	const config = stripeConfig(c.env);
	if (!config) return c.html(notForSalePage(lang), 404);
	if (isProPlan(proPlan)) return startProCheckout(c, account, config, proPlan, lang, next);
	return openCheckout(c, account, config, lang, next, '', messages[lang].buyTitle, (checkout) => {
		const done = new URLSearchParams({ next: checkout.next, lang: checkout.lang });
		return createCheckoutSession(config, {
			...checkout.session,
			// `{CHECKOUT_SESSION_ID}` は Stripe が置き換える (URLSearchParams に通すと括弧が符号化されるので、後ろに足す)。
			successUrl: `${checkout.origin}${ACCOUNT}/buy/done?${done}&session_id={CHECKOUT_SESSION_ID}`,
			// Stripe の画面で戻ったら、買い直せる最終確認の画面へ戻す。
			cancelUrl: `${checkout.origin}${ACCOUNT}/buy?lang=${checkout.lang}`,
			submitMessage: checkout.session.managedPayments
				? undefined
				: messages[checkout.lang].checkoutNote(LEGAL_PAGES.tokushoho),
			idempotencyKey: `mawok-checkout-${checkout.id}`
		});
	});
});

/** 支払いの画面の予約。`session` は Checkout Session を作るときにそのまま渡す分。 */
type Checkout = {
	id: string;
	next: string;
	lang: Lang;
	origin: string;
	session: {
		accountId: string;
		email: string;
		lang: Lang;
		expiresAt: number;
		managedPayments: boolean;
		buyerCountry?: string;
	};
};

/**
 * 支払いの画面の予約を取り、画面を作って送る。開いている画面があれば同じ画面へ送り、2つのタブや、確かめを待つ間の買い直しで
 * 二重に払わせないように。払い終えた画面を開き直すと、Stripe が払い終えたことを示す。
 * `price` は残高なら空、Pro ならプラン。違うものを押し直すと、古い支払い画面は閉じる。
 */
async function openCheckout(
	c: Context<App>,
	account: { id: string; email: string },
	config: StripeConfig,
	lang: Lang,
	next: string,
	price: '' | ProPlan,
	title: string,
	create: (checkout: Checkout) => Promise<{ id: string; url: string }>
) {
	const t = now();
	const old = await c.env.DB.prepare(
		'SELECT id, price, session_id FROM checkouts WHERE account_id = ? AND expires_at > ?'
	)
		.bind(account.id, t)
		.first<{ id: string; price: string; session_id: string | null }>();
	if (old && old.price !== price) {
		if (old.session_id) await expireCheckoutSession(config, old.session_id);
		await c.env.DB.prepare('DELETE FROM checkouts WHERE id = ?').bind(old.id).run();
	}
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM checkouts WHERE expires_at <= ?').bind(t),
		c.env.DB.prepare(
			`INSERT INTO checkouts (id, account_id, next, lang, expires_at, managed_payments, buyer_country, price)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (account_id) DO NOTHING`
		).bind(
			randomHex(16),
			account.id,
			next,
			lang,
			t + CHECKOUT_TTL,
			usesManagedPayments(buyerCountry(c)) ? 1 : 0,
			buyerCountry(c) ?? null,
			price
		)
	]);
	const row = (await c.env.DB.prepare(
		`SELECT id, next, lang, url, expires_at, managed_payments, buyer_country
		 FROM checkouts WHERE account_id = ?`
	)
		.bind(account.id)
		.first<{
			id: string;
			next: string;
			lang: Lang;
			url: string | null;
			expires_at: number;
			managed_payments: number;
			buyer_country: string | null;
		}>())!;
	if (row.url) return c.redirect(row.url, 303);
	// 画面がまだ無い予約 (ほかのタブが頼んでいる最中か、頼んだあとに失敗した) は、同じキーで頼み直す。
	// Stripe は作り終えた Session をそのまま返すので、画面は1つのまま。
	let session: { id: string; url: string };
	try {
		session = await create({
			id: row.id,
			next: row.next,
			lang: row.lang,
			origin: new URL(c.req.url).origin,
			session: {
				accountId: account.id,
				email: account.email,
				lang: row.lang,
				expiresAt: row.expires_at,
				managedPayments: row.managed_payments === 1,
				buyerCountry: row.buyer_country ?? undefined
			}
		});
	} catch (e) {
		// 同じ予約をほかのタブが頼んでいる最中。予約は残し、押し直してもらう。
		if (e instanceof StripeError && e.status === 409) {
			return c.html(messagePage(lang, title, messages[lang].buyBusy), 409);
		}
		// 応答が届かなかったときは、Stripe が作ったかどうか分からない。予約を残し、押し直したら同じキーで頼み直す。
		if (!(e instanceof StripeError)) throw e;
		// Stripe が断ったときは予約を外し、押し直したら新しく頼めるように (同じキーでは、Stripe は同じ失敗を返し続ける)。
		await c.env.DB.prepare('DELETE FROM checkouts WHERE id = ? AND url IS NULL').bind(row.id).run();
		throw e;
	}
	await c.env.DB.prepare('UPDATE checkouts SET url = ?, session_id = ? WHERE id = ?')
		.bind(session.url, session.id, row.id)
		.run();
	return c.redirect(session.url, 303);
}

/**
 * 支払いから戻った先。webhook が届いて残高が付く (Pro なら有効になる) のを待ち、付いたら予約を外して `next` へ進む。
 * 予約を外すのは、次の買い足しで、払い終えた支払いの画面へ送らないため。
 */
accountApp.get('/buy/done', async (c) => {
	const lang = resolveLang(c);
	const next = safeNext(c.req.query('next'));
	const account = await currentAccount(c);
	if (!account) return c.html(signIn(c, lang, next));
	const pro = c.req.query('pro') === '1';
	const forward = async (url: string) => {
		await c.env.DB.prepare('DELETE FROM checkouts WHERE account_id = ?').bind(account.id).run();
		return c.redirect(url, 303);
	};
	if (pro) {
		if ((await proOf(c.env, account.id)).active) return forward(next);
	} else {
		const bought = await c.env.DB.prepare(
			`SELECT 1 FROM grants JOIN purchases ON purchases.id = grants.purchase_id
			 WHERE purchases.stripe_checkout_session_id = ? AND grants.account_id = ?`
		)
			.bind(c.req.query('session_id') ?? '', account.id)
			.first();
		if (bought) {
			const url = new URL(next, c.req.url);
			url.searchParams.set('bought', '1');
			return forward(`${url.pathname}${url.search}`);
		}
	}
	const tries = Number(c.req.query('tries') ?? '0') || 0;
	const retry = new URL(c.req.url);
	retry.searchParams.set('tries', String(tries + 1));
	return c.html(
		checkingPurchasePage(lang, pro, `${retry.pathname}${retry.search}`, tries < PURCHASE_CHECKS)
	);
});

async function hadSubscription(env: Env, accountId: string) {
	return (
		(await env.DB.prepare('SELECT 1 FROM subscriptions WHERE account_id = ?')
			.bind(accountId)
			.first()) !== null
	);
}

/** Pro の Checkout を予約して作る。プランを替えて押し直すと、古い支払い画面は閉じる。 */
async function startProCheckout(
	c: Context<App>,
	account: { id: string; email: string },
	config: StripeConfig,
	plan: ProPlan,
	lang: Lang,
	next: string
) {
	if (!proForSale(config)) return c.html(proUnavailablePage(lang), 404);
	if ((await proOf(c.env, account.id)).active) return c.redirect(next, 303);
	return openCheckout(
		c,
		account,
		config,
		lang,
		next,
		plan,
		messages[lang].proTitle,
		async (checkout) => {
			const done = new URLSearchParams({ next: checkout.next, lang: checkout.lang, pro: '1' });
			return createProCheckoutSession(config, {
				...checkout.session,
				plan,
				successUrl: `${checkout.origin}${ACCOUNT}/buy/done?${done}`,
				cancelUrl: `${checkout.origin}${ACCOUNT}/buy?plan=${plan}&lang=${checkout.lang}`,
				submitMessage: checkout.session.managedPayments
					? undefined
					: messages[checkout.lang].proCheckoutNote,
				trial: !(await hadSubscription(c.env, account.id)),
				idempotencyKey: `mawok-pro-checkout-${checkout.id}`
			});
		}
	);
}

/** Stripe のカスタマーポータル (解約・支払い方法・領収書)。 */
accountApp.post('/billing', async (c) => {
	const lang = resolveLang(c);
	const account = await currentAccount(c);
	if (!account) return c.html(signIn(c, lang, ACCOUNT_HOME), 401);
	const config = stripeConfig(c.env);
	const row = await c.env.DB.prepare(
		`SELECT stripe_customer_id FROM subscriptions WHERE account_id = ? AND stripe_customer_id IS NOT NULL ORDER BY paid_through DESC`
	)
		.bind(account.id)
		.first<{ stripe_customer_id: string }>();
	if (!config || !row) return c.redirect(ACCOUNT_HOME, 303);
	return c.redirect(
		await billingPortalUrl(
			config,
			row.stripe_customer_id,
			`${new URL(c.req.url).origin}${ACCOUNT_HOME}`,
			lang
		),
		303
	);
});

app.route(ACCOUNT, accountApp);

/** 1日ごとに、期限が過ぎた同期の暗号文と消した記録を掃除する。 */
export function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
	ctx.waitUntil(purgeSync(env));
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
