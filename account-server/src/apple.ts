/**
 * Apple でのサインイン (→ docs/account-server.md「サインイン」)。Sign in with Apple の REST API の Authorization Code + state + nonce。
 * PKCE は掛けない。Apple の認可とトークンのエンドポイントに、その項目が無いため。
 * 往復の間の state・nonce は Cookie に持つ (→ src/cookie.ts の setFlowCookie)。
 */
import type { Context } from 'hono';
import { setFlowCookie, takeFlowCookie } from './cookie';
import { isLang, type Lang } from './i18n';
import { ACCOUNT_HOME, base64url, formString, jwtClaims, normalizeEmail, randomHex } from './util';

const AUTHORIZATION_ENDPOINT = 'https://appleid.apple.com/auth/authorize';
const TOKEN_ENDPOINT = 'https://appleid.apple.com/auth/token';
const ISSUER = 'https://appleid.apple.com';
/** Apple の画面でサインインして戻るまでの猶予。 */
const FLOW_TTL = 10 * 60;
/** 引き換えに使う client_secret の有効期間。呼ぶたびに作るので、短くてよい。 */
const CLIENT_SECRET_TTL = 5 * 60;

type AppleConfig = { teamId: string; keyId: string; privateKey: string; serviceId: string };

/** 4つそろったときだけ、Apple でサインインできる。 */
export function appleConfig(env: Env): AppleConfig | undefined {
	const { APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY, APPLE_SERVICE_ID } = env;
	if (!APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY || !APPLE_SERVICE_ID) return undefined;
	return {
		teamId: APPLE_TEAM_ID,
		keyId: APPLE_KEY_ID,
		privateKey: APPLE_PRIVATE_KEY,
		serviceId: APPLE_SERVICE_ID
	};
}

/** `lang`: 戻ったときの画面の言語。Apple からの POST には言語の Cookie (SameSite=Lax) が付かないので、ここに持つ。 */
type Flow = { state: string; nonce: string; next: string; lang: Lang };

const COOKIE = 'apple';

/** Apple の画面へ送る URL を作り、戻ってきたときに確かめる値を Cookie に残す。 */
export function startAppleSignIn(
	c: Context<{ Bindings: Env }>,
	config: AppleConfig,
	redirectUri: string,
	next: string,
	lang: Lang
): string {
	const flow: Flow = { state: randomHex(16), nonce: randomHex(16), next, lang };
	// Apple は戻り先へ POST で送る (form_post) ので、よそのサイトからの POST でも Cookie が届くようにする。
	setFlowCookie(c, COOKIE, flow, FLOW_TTL, { crossSitePost: true });
	return `${AUTHORIZATION_ENDPOINT}?${new URLSearchParams({
		client_id: config.serviceId,
		response_type: 'code',
		// scope を求めるときは form_post だけ。名前は使わないので求めない。
		response_mode: 'form_post',
		scope: 'email',
		redirect_uri: redirectUri,
		state: flow.state,
		nonce: flow.nonce
	})}`;
}

/** Apple が確かめたアカウント。 */
type AppleUser = { subject: string; email: string; next: string; lang?: Lang };

/** 確かめられなかった理由。`cancelled` は利用者が Apple の画面で取り消した。 */
type AppleFailure = { failure: 'invalid' | 'cancelled'; next: string; lang?: Lang };

/**
 * 戻ってきた `code` を ID トークンに替え、Apple が確かめたアカウントを返す。
 * ID トークンは Apple のトークンのエンドポイントから直接受け取るので、署名は確かめない
 * (OpenID Connect Core 3.1.3.7)。発行元・宛先・期限・nonce は確かめる。
 */
export async function finishAppleSignIn(
	c: Context<{ Bindings: Env }>,
	config: AppleConfig,
	redirectUri: string,
	nowSeconds: number
): Promise<AppleUser | AppleFailure> {
	const flow = takeFlowCookie<Flow>(c, COOKIE);
	if (!flow) return { failure: 'invalid', next: ACCOUNT_HOME };
	const lang = isLang(flow.lang) ? flow.lang : undefined;
	const fail = (failure: AppleFailure['failure']): AppleFailure => ({
		failure,
		next: flow.next,
		lang
	});
	const form = await c.req.parseBody();
	if (!flow.state || formString(form, 'state') !== flow.state) return fail('invalid');
	if (formString(form, 'error') === 'user_cancelled_authorize') return fail('cancelled');
	const code = formString(form, 'code');
	if (!code) return fail('invalid');
	const res = await fetch(TOKEN_ENDPOINT, {
		method: 'POST',
		body: new URLSearchParams({
			client_id: config.serviceId,
			client_secret: await clientSecret(config, nowSeconds),
			code,
			grant_type: 'authorization_code',
			redirect_uri: redirectUri
		})
	});
	if (!res.ok) {
		console.error('Apple token endpoint failed', res.status, await res.text());
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
		// Apple は真偽値か文字列で返す。
		email_verified?: boolean | string;
	}>(idToken);
	if (
		!claims ||
		claims.iss !== ISSUER ||
		claims.aud !== config.serviceId ||
		(claims.exp ?? 0) <= nowSeconds ||
		claims.nonce !== flow.nonce ||
		!claims.sub ||
		!claims.email ||
		String(claims.email_verified) !== 'true'
	) {
		return fail('invalid');
	}
	return { subject: claims.sub, email: normalizeEmail(claims.email), next: flow.next, lang };
}

/** 引き換えに要る client_secret。Apple の秘密鍵 (.p8) で署名した ES256 の JWT。 */
async function clientSecret(config: AppleConfig, nowSeconds: number): Promise<string> {
	const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
	const input = `${encode({ alg: 'ES256', kid: config.keyId })}.${encode({
		iss: config.teamId,
		iat: nowSeconds,
		exp: nowSeconds + CLIENT_SECRET_TTL,
		aud: ISSUER,
		sub: config.serviceId
	})}`;
	const der = Uint8Array.from(atob(config.privateKey.replace(/-----[^-]+-----|\s/g, '')), (ch) =>
		ch.charCodeAt(0)
	);
	const key = await crypto.subtle.importKey(
		'pkcs8',
		der,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign']
	);
	// Web Crypto の ECDSA の署名は r と s を並べた形で、JWS の ES256 の形と同じ。
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		new TextEncoder().encode(input)
	);
	return `${input}.${base64url(new Uint8Array(signature))}`;
}
