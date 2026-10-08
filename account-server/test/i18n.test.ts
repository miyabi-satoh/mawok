import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { resolveLang } from '../src/i18n';
// テストは Workers の中で動き、ファイルを読めないので、ソースを文字列として取り込む
import source from '../src/i18n.ts?raw';

/** その要求で選ばれた言語と、残した Cookie。 */
async function langOf(path: string, headers: Record<string, string> = {}) {
	const probe = new Hono().get('/', (c) => c.text(resolveLang(c)));
	const res = await probe.request(path, { headers });
	return { lang: await res.text(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

describe('resolveLang', () => {
	it('follows the browser language and falls back to English', async () => {
		for (const [acceptLanguage, lang] of [
			['ja-JP,en;q=0.8', 'ja'],
			['fr-FR,en;q=0.5,ja;q=0.9', 'ja'],
			['en-US', 'en'],
			['fr-FR', 'en'],
			['ja;q=0,en;q=0.1', 'en'],
			['', 'en']
		]) {
			expect((await langOf('/', { 'accept-language': acceptLanguage })).lang, acceptLanguage).toBe(
				lang
			);
		}
	});

	it('keeps the language given in the link over the cookie and the browser language', async () => {
		expect(await langOf('/?lang=en', { 'accept-language': 'ja', cookie: 'lang=ja' })).toEqual({
			lang: 'en',
			cookie: 'lang=en'
		});
		expect(await langOf('/', { 'accept-language': 'ja', cookie: 'lang=en' })).toEqual({
			lang: 'en',
			cookie: undefined
		});
		// 持っていない言語は無いものとして扱う。
		expect((await langOf('/?lang=fr', { 'accept-language': 'ja', cookie: 'lang=fr' })).lang).toBe(
			'ja'
		);
	});
});

describe('日本語の文言', () => {
	// 数字と単位の間は、そこで折り返さないようノーブレークスペースにする (画面の文言は src/lib/messages.test.ts が見る)
	it('数字と単位の間に、ノーブレークスペース以外を置かない', () => {
		const breakable = source
			.split('\n')
			// コメントは画面に出ないので見ない
			.filter((line) => !/^\s*(?:\/\*\*|\*|\/\/)/.test(line))
			.filter((line) =>
				/(?:\d|\$\{\w+\}) ?(?:秒|分|時間|日|週|か月|年|件|回|文字|行|個|円)/.test(line)
			);
		expect(breakable).toEqual([]);
	});
});
