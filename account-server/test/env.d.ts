declare namespace Cloudflare {
	interface Env {
		TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
		/** Apple の秘密鍵の公開鍵 (JWK)。 */
		TEST_APPLE_PUBLIC_KEY: string;
	}
}

/** Vite の `?raw` で、ファイルを文字列として取り込む。 */
declare module '*?raw' {
	const content: string;
	export default content;
}
