import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import { loadConfig } from '@sveltejs/load-config';

// 読めなくても loadConfig は投げずに error を返すので、黙って前処理なしで lint しないよう止める
const loaded = await loadConfig('./', { traverse: false });
if (!loaded?.config)
	throw new Error(`couldn't load the Svelte config: ${loaded?.error ?? 'not found'}`);
const svelteConfig = loaded.config;

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	{
		// shadcn-svelte が生成するコンポーネント (registry からの取得物なので対象外)
		ignores: [
			'src/lib/components/ui/**',
			'src/lib/bindings/**',
			// Claude Code が作る worktree (別のブランチの作業フォルダで、そちらの検査が見る)
			'.claude/worktrees/**'
		]
	},
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		}
	},
	{
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {}
	}
);
