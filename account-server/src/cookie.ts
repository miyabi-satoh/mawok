import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { isHttps } from './util';

/**
 * https では `__Host-` を付け、`Path=/`・`Domain` 無しをブラウザに守らせる。
 * amiiby.com の別のサブドメインから同名の Cookie を送り込まれないように。
 */
function hostCookieName(c: Context, base: string): string {
	return isHttps(c) ? `__Host-${base}` : base;
}

/**
 * `SameSite` は Strict にしない。Mawok から開くリンクやメールのリンク・Google から戻るとき (よそのサイトからの移動) に、
 * Cookie が送られなくなるため。書き込みは Origin の確かめ (hono/csrf) で守る。
 * `crossSitePost`: よそのサイトからの POST でも送る (Apple から戻るとき)。https でだけ効く (`SameSite=None` は `Secure` が要る)。
 */
export function setHostCookie(
	c: Context,
	base: string,
	value: string,
	maxAge: number,
	{ crossSitePost = false }: { crossSitePost?: boolean } = {}
) {
	setCookie(c, hostCookieName(c, base), value, {
		path: '/',
		httpOnly: true,
		secure: isHttps(c),
		sameSite: crossSitePost && isHttps(c) ? 'None' : 'Lax',
		maxAge
	});
}

export function getHostCookie(c: Context, base: string): string | undefined {
	return getCookie(c, hostCookieName(c, base));
}

export function deleteHostCookie(c: Context, base: string) {
	deleteCookie(c, hostCookieName(c, base), { path: '/', secure: isHttps(c) });
}

/**
 * 外部のサインインの往復の間に持つ値 (state・nonce・戻り先など) を Cookie に置く。認証の要らない D1 の書き込みを増やさないため。
 * 値は JSON にし、ASCII の文字だけを入れる (btoa は Latin-1 の外の文字を扱えない)。
 */
export function setFlowCookie(
	c: Context,
	base: string,
	value: object,
	maxAge: number,
	options?: { crossSitePost?: boolean }
) {
	setHostCookie(c, base, btoa(JSON.stringify(value)), maxAge, options);
}

/** 往復の印を読んで消す (使えるのは一度だけ)。無いか読めなければ `undefined`。 */
export function takeFlowCookie<T>(c: Context, base: string): T | undefined {
	const raw = getHostCookie(c, base);
	deleteHostCookie(c, base);
	try {
		return JSON.parse(atob(raw ?? '')) as T;
	} catch {
		return undefined;
	}
}
