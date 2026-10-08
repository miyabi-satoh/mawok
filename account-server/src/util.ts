/** 今の時刻 (UNIX 秒)。 */
export function now(): number {
	return Math.floor(Date.now() / 1000);
}

/** 推測できない乱数を16進の文字列で。 */
export function randomHex(bytes: number): string {
	return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** トークンや秘密は、この値だけを D1 に持つ。D1 が漏れても使えないように。 */
export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** フォームの値のうち、文字列のものだけを取り出す (ファイルは除く)。 */
export function formString(form: Record<string, unknown>, key: string): string | undefined {
	const value = form[key];
	return typeof value === 'string' ? value : undefined;
}

/** https で受けたか。Cookie の `Secure` と `__Host-` を付けるかを決める。 */
export function isHttps(c: { req: { url: string } }): boolean {
	return new URL(c.req.url).protocol === 'https:';
}

/** 送れそうな形か。確かめるのはメールが届くことでする。 */
export function isEmail(email: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

function decodeBase64url(text: string): string {
	return atob(text.replaceAll('-', '+').replaceAll('_', '/'));
}

/**
 * JWT (ID トークン) の中身を読む。署名は確かめないので、提供元のトークンのエンドポイントから直接受け取ったものにだけ使う。
 * 読めなければ `undefined`。
 */
export function jwtClaims<T>(jwt: string | undefined): T | undefined {
	try {
		return JSON.parse(decodeBase64url(jwt?.split('.')[1] ?? '')) as T;
	} catch {
		return undefined;
	}
}

/** 人が開く画面 (サインイン・Mawok を結ぶ・買う) を置くパス。 */
export const ACCOUNT = '/account';
/** 公開の料金ページ (site/src/pages/pricing.astro)。 */
export const PRICING_PATH = '/pricing/';
/** アカウントの画面。 */
export const ACCOUNT_HOME = `${ACCOUNT}/`;

/**
 * サインインの後に戻る先。よそのサイトへ送られないよう、このサイトの中のパスだけを通す。
 * 空白や制御文字も通さない。ブラウザは URL のタブや改行を読み捨てるので、`/\t/evil.test` が `//evil.test` になる。
 */
export function safeNext(next: string | undefined): string {
	return next && /^\/(?![/\\])[\x21-\x7e]*$/.test(next) ? next : ACCOUNT_HOME;
}
