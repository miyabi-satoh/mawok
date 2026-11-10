<script lang="ts">
	import { ModeWatcher } from 'mode-watcher';
	import { allowsContextMenu } from '$lib/context-menu';
	import { getLocale } from '$lib/paraglide/runtime';
	import './layout.css';

	const { children } = $props();

	// SPA なのでサーバーで lang を埋め込めない。読み上げや IME の候補のために実行時に設定する
	$effect(() => {
		document.documentElement.lang = getLocale();
	});

	// WebView のブラウザーとしてのメニュー（最新の情報に更新など）を出さない。開発版では、要素の検証に使うので残す
	function onContextMenu(event: MouseEvent) {
		if (import.meta.env.DEV) return;
		if (!allowsContextMenu(event.target, window.getSelection()?.toString() ?? '')) {
			event.preventDefault();
		}
	}
</script>

<svelte:window oncontextmenu={onContextMenu} />

<ModeWatcher />
{@render children()}
