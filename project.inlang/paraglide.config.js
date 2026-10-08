import { defineConfig } from '@inlang/paraglide-js';

// 文言の生成の設定。Vite プラグイン（vite.config.ts）と CLI（pnpm run paraglide）の両方がこれを読むので、
// どちらで作り直しても同じものができる
export default defineConfig({
	outdir: './src/lib/paraglide',
	emitTsDeclarations: true,
	// 明示しないと、Vite プラグインだけが dev のときに locale-modules で作り、
	// CLI や build で作ったものと形が変わる
	outputStructure: 'message-modules',
	// 表示言語は Rust 側の設定で決め、src/lib/settings.svelte.ts で getLocale を差し替える。
	// 差し替える前（起動直後）だけ、OS の言語 → 英語の順で決める
	strategy: ['preferredLanguage', 'baseLocale'],
	// Vite プラグインが既定で入れている式。CLI で作り直したときに食い違わないよう、こちらにも書く
	isServer: "import.meta.env?.SSR ?? typeof window === 'undefined'"
});
