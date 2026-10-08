/**
 * Google でのサインイン (→ docs/account-server.md「サインイン」)。OpenID Connect の Authorization Code + PKCE。
 * 往復の間の state・nonce・code_verifier は Cookie に持つ (→ src/cookie.ts の setFlowCookie)。
 * エンドポイントは Google の discovery の文書 (https://accounts.google.com/.well-known/openid-configuration) のもの。
 */
import type { Context } from 'hono';
import { setFlowCookie, takeFlowCookie } from './cookie';
import { ACCOUNT_HOME, base64url, jwtClaims, normalizeEmail, randomHex } from './util';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
/** Google の画面でアカウントを選んで戻るまでの猶予。 */
const FLOW_TTL = 10 * 60;

type GoogleConfig = { clientId: string; clientSecret: string };

/** 2つそろったときだけ、Google でサインインできる。 */
export function googleConfig(env: Env): GoogleConfig | undefined {
	const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
	if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return undefined;
	return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET };
}

type Flow = { state: string; nonce: string; verifier: string; next: string };

const COOKIE = 'google';

/** Google の画面へ送る URL を作り、戻ってきたときに確かめる値を Cookie に残す。 */
export async function startGoogleSignIn(
	c: Context<{ Bindings: Env }>,
	config: GoogleConfig,
	redirectUri: string,
	next: string
): Promise<string> {
	const flow: Flow = { state: randomHex(16), nonce: randomHex(16), verifier: randomHex(32), next };
	setFlowCookie(c, COOKIE, flow, FLOW_TTL);
	const challenge = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(flow.verifier))
	);
	return `${AUTHORIZATION_ENDPOINT}?${new URLSearchParams({
		client_id: config.clientId,
		response_type: 'code',
		scope: 'openid email',
		redirect_uri: redirectUri,
		state: flow.state,
		nonce: flow.nonce,
		code_challenge: base64url(challenge),
		code_challenge_method: 'S256',
		// 複数の Google アカウントを使う人が、どれで入るかを選べるように。
		prompt: 'select_account'
	})}`;
}

/** Google が確かめたアカウント。 */
type GoogleUser = { subject: string; email: string; next: string };

/** 確かめられなかった理由。`unconfirmed_email` は利用者に伝える。ほかはやり直してもらうだけ。 */
type GoogleFailure = { failure: 'invalid' | 'unconfirmed_email'; next: string };

/**
 * 戻ってきた `code` を ID トークンに替え、Google が確かめたアカウントを返す。
 * ID トークンは Google のトークンのエンドポイントから client secret で直接受け取るので、署名は確かめない
 * (Google の OpenID Connect の資料「Validating an ID token」)。発行元・宛先・期限・nonce は確かめる。
 */
export async function finishGoogleSignIn(
	c: Context<{ Bindings: Env }>,
	config: GoogleConfig,
	redirectUri: string,
	nowSeconds: number
): Promise<GoogleUser | GoogleFailure> {
	const flow = takeFlowCookie<Flow>(c, COOKIE);
	if (!flow) return { failure: 'invalid', next: ACCOUNT_HOME };
	// 断ったときも、メールのリンクで入り直して元の画面 (Mawok を結ぶ画面など) へ戻れるように。
	const fail = (failure: GoogleFailure['failure']): GoogleFailure => ({ failure, next: flow.next });
	const code = c.req.query('code');
	if (!code || !flow.state || c.req.query('state') !== flow.state) return fail('invalid');
	const res = await fetch(TOKEN_ENDPOINT, {
		method: 'POST',
		body: new URLSearchParams({
			code,
			client_id: config.clientId,
			client_secret: config.clientSecret,
			redirect_uri: redirectUri,
			grant_type: 'authorization_code',
			code_verifier: flow.verifier
		})
	});
	if (!res.ok) {
		console.error('Google token endpoint failed', res.status, await res.text());
		return fail('invalid');
	}
	const { id_token: idToken } = await res.json<{ id_token?: string }>();
	const claims = jwtClaims<{
		iss?: string;
		aud?: string;
		exp?: number;
		nonce?: string;
		sub?: string;
		email?: string;
		email_verified?: boolean;
		hd?: string;
	}>(idToken);
	if (
		!claims ||
		!ISSUERS.includes(claims.iss ?? '') ||
		claims.aud !== config.clientId ||
		(claims.exp ?? 0) <= nowSeconds ||
		claims.nonce !== flow.nonce ||
		!claims.sub
	) {
		return fail('invalid');
	}
	// Google が持ち主を確かだと言えるメールだけを受け付ける。Gmail か、Google Workspace (hd がある) のもの。
	// ほかのメールは、Google アカウントを作ったときに確かめただけで、今の持ち主かは分からない
	// (Google の資料「Verify the Google ID token on your server side」)。受け付けると、他人のメールで
	// 作った Google アカウントから、そのメールの窓口のアカウントに入れてしまう。
	const email = claims.email === undefined ? undefined : normalizeEmail(claims.email);
	const confirmed =
		claims.email_verified === true &&
		email !== undefined &&
		(email.endsWith('@gmail.com') || claims.hd !== undefined);
	if (!confirmed) return fail('unconfirmed_email');
	return { subject: claims.sub, email, next: flow.next };
}
