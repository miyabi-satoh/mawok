import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { playwright } from '@vitest/browser-playwright';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { thirdPartyLicenses } from './scripts/third-party-licenses.ts';

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
		projects: [
			// 画面の部品のテスト。Chromium（Playwright）で実際に描いて操作する。
			// ResizeObserver や IME の扱いなど、実物に近いところを見たいので jsdom にはしない
			{
				extends: true,
				// 部品が import する依存を、起動時にまとめて見つけて最適化しておく。
				// 既定では見つけきれず、キャッシュにない依存（新しく使ったアイコンなど）をテストの途中で最適化し直すと、
				// Vite が読み込み直してテストがまとめて落ちることがある
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
						instances: [{ browser: 'chromium' }]
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
