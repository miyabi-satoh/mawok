<script lang="ts">
	import { ModeWatcher } from 'mode-watcher';
	import { getLocale } from '$lib/paraglide/runtime';
	import './layout.css';

	const { children } = $props();

	// SPA なのでサーバーで lang を埋め込めない。読み上げや IME の候補のために実行時に設定する
	$effect(() => {
		document.documentElement.lang = getLocale();
	});
</script>

<ModeWatcher />
{@render children()}
