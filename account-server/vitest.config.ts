import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/** テストでも手元と同じ秘密の値 (dev.vars.example) を使う。 */
function devVars(): Record<string, string> {
	return Object.fromEntries(
		readFileSync(new URL('./dev.vars.example', import.meta.url), 'utf8')
			.split('\n')
			.filter((line) => line && !line.startsWith('#'))
			.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
	);
}

// Apple の秘密鍵 (.p8 と同じ PKCS#8 の P-256)。テストは公開鍵で client_secret の署名を確かめる。
const appleKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });

// `secrets.required` の値が無いという警告を出さないよう、process.env にも置く。
Object.assign(process.env, devVars());

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: './wrangler.jsonc' },
			miniflare: {
				bindings: {
					...devVars(),
					MAIL_LOG_ONLY: '1',
					// Stripe へはつながない (テストが fetch を差し替える)。webhook の署名はこの値で作る。
					STRIPE_SECRET_KEY: 'sk_test_dummy',
					STRIPE_WEBHOOK_SECRET: 'whsec_test',
					STRIPE_AI_CREDITS_PRICE_ID: 'price_credits',
					// 無料の分の上限。テストでは多くのアカウントを作るので、上限を試すテストのほかで当たらない額にする。
					FREE_MONTHLY_CAP_YEN: '1000000',
					GOOGLE_CLIENT_ID: 'google-client',
					GOOGLE_CLIENT_SECRET: 'google-secret',
					APPLE_TEAM_ID: 'TEAM123456',
					APPLE_KEY_ID: 'KEY1234567',
					APPLE_PRIVATE_KEY: appleKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
					APPLE_SERVICE_ID: 'com.example.web',
					TEST_APPLE_PUBLIC_KEY: JSON.stringify(appleKey.publicKey.export({ format: 'jwk' })),
					TEST_MIGRATIONS: await readD1Migrations('./migrations')
				}
			}
		}))
	],
	// 差し替えた fetch や console は、テストごとに戻す。
	test: { setupFiles: ['./test/apply-migrations.ts'], restoreMocks: true }
});
