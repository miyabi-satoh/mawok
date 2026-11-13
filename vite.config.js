import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { playwright } from '@vitest/browser-playwright';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { thirdPartyLicenses } from './scripts/third-party-licenses.ts';
import { flakyAnnotations } from './scripts/vitest-flaky-annotations.ts';

import process from 'node:process';

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
	plugins: [
		tailwindcss(),
		// 画面に同梱した npm のパッケージのライセンス表示を、ビルドのたびに書き出す
		thirdPartyLicenses(),
		sveltekit(),
		// 出力先や strategy は project.inlang/paraglide.config.js に書いてある（CLI と共通）
		paraglideVitePlugin({ project: './project.inlang' })
	],

	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent Vite from obscuring rust errors
	clearScreen: false,

	test: {
		// 落ちたテストを2回まで流し直す (Playwright のひな形が CI で使う回数)。機械が詰まって時々落ちるテストで、CI や手元の検査が止まらないようにする。
		// 流し直して通ったテストは flakyAnnotations が最後に警告で出し (CI では github-actions の reporter が実行の概要にも書く)、埋もれずに直す相手として見える
		retry: 2,
		// 場所を出せば、警告から行へ飛べる
		includeTaskLocation: true,
		// reporters を書くと既定が置き換わるので、既定 (エージェントでは minimal、GitHub Actions では github-actions も) に足す
		reporters: [...configDefaults.reporters, flakyAnnotations()],
		projects: [
			// 画面の部品のテスト。Chromium（Playwright）で実際に描いて操作する。
			// ResizeObserver や IME の扱いなど、実物に近いところを見たいので jsdom にはしない
			{
				extends: true,
				// 部品が import する依存を、起動時にまとめて見つけて最適化しておく。
				// 既定では見つけきれず、キャッシュにない依存（新しく使ったアイコンなど）をテストの途中で最適化し直すと、
				// Vite が読み込み直してテストがまとめて落ちることがある。
				// 探すのはキャッシュが無いとき（CI・依存か Vite の設定を変えた後）だけで、手元のキャッシュが残ったまま新しいアイコンを
				// 使い始めた最初の1回は同じ理由で落ちうる。そのときは流し直せば、最適化し直したキャッシュで通る
				optimizeDeps: {
					entries: ['src/**/*.svelte']
				},
				test: {
					name: 'client',
					include: ['src/**/*.svelte.test.ts'],
					browser: {
						enabled: true,
						provider: playwright(),
						headless: true,
						instances: [{ browser: /** @type {const} */ ('chromium') }]
					}
				}
			},
			// 純粋な TypeScript のテスト
			{
				extends: true,
				test: {
					name: 'node',
					environment: 'node',
					include: ['src/**/*.test.ts'],
					exclude: ['src/**/*.svelte.test.ts']
				}
			}
		]
	},

	// 2. tauri expects a fixed port, fail if that port is not available
	server: {
		port: 1420,
		strictPort: true,
		host: host || '127.0.0.1',
		hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
		watch: {
			// 3. tell Vite to ignore watching `src-tauri`
			ignored: ['**/src-tauri/**']
		}
	}
}));
