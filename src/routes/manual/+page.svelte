<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { isCloseWindowKey } from '$lib/keys';
	import { renderManual } from '$lib/manual';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import en from '../../../docs/manual/en.md?raw';
	import ja from '../../../docs/manual/ja.md?raw';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// 本文は画面の表示言語で出す。開いたまま設定で言語を変えたときも追う
	const locale = $derived(getLocale());
	const manual = $derived(renderManual(locale === 'en' ? en : ja, m.manual_table(), data.platform));

	/** 設定ウィンドウと同じく、Esc と Cmd+W（Windows は Ctrl+W）で閉じる */
	function onKeydown(event: KeyboardEvent) {
		if (isCloseWindowKey(event, data.platform)) {
			event.preventDefault();
			invoke('close_manual_window');
		}
	}

	/**
	 * 目次から節へ移る。スクロールするのはページではなく main なので、URL の # に任せず、
	 * 見出しまで送ってフォーカスも移す (読み上げも移った先から続く)
	 */
	function jump(event: MouseEvent, id: string) {
		event.preventDefault();
		const heading = document.getElementById(id);
		if (!heading) return;
		heading.scrollIntoView({ block: 'start' });
		heading.focus({ preventScroll: true });
	}

	/** ウィンドウは隠して作られるので、画面を描いてから表示させる */
	function showWindow() {
		invoke('show_manual_window');
	}
</script>

<svelte:window onkeydown={onKeydown} />

<main class="h-dvh overflow-y-auto px-6 py-6" {@attach showWindow} lang={locale}>
	<h1 class="text-lg font-semibold">{manual.title}</h1>
	<nav class="mt-3" aria-label={m.manual_contents()}>
		<ul class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
			{#each manual.sections as section (section.id)}
				<li>
					<a
						href="#{section.id}"
						class="text-primary underline underline-offset-2 hover:decoration-2"
						onclick={(event) => jump(event, section.id)}>{section.title}</a
					>
				</li>
			{/each}
		</ul>
	</nav>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- ソースは同梱の docs/manual/*.md だけで、外から入る文字を含まない -->
	<article class="manual mt-2">{@html manual.html}</article>
</main>

<style>
	.manual :global(h2) {
		margin-top: 2rem;
		padding-bottom: 0.25rem;
		border-bottom: 1px solid var(--border);
		font-size: 1rem;
		font-weight: 600;
		scroll-margin-top: 1rem;
	}
	.manual :global(h3) {
		margin-top: 1.25rem;
		font-size: 0.875rem;
		font-weight: 600;
	}
	.manual :global(:is(p, ul, ol, .table-scroll)) {
		margin-top: 0.5rem;
		font-size: 0.875rem;
		line-height: 1.7;
	}
	.manual :global(ul) {
		list-style: disc;
		padding-left: 1.25rem;
	}
	.manual :global(ol) {
		list-style: decimal;
		padding-left: 1.25rem;
	}
	.manual :global(li > :is(ul, ol)) {
		margin-top: 0.25rem;
	}
	.manual :global(code) {
		border-radius: 0.25rem;
		background: var(--muted);
		padding: 0 0.25rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.9em;
	}
	.manual :global(.table-scroll) {
		overflow-x: auto;
	}
	.manual :global(table) {
		border-collapse: collapse;
		font-size: 0.8125rem;
		line-height: 1.5;
	}
	.manual :global(:is(th, td)) {
		border: 1px solid var(--border);
		padding: 0.25rem 0.5rem;
		text-align: left;
		vertical-align: top;
	}
	.manual :global(th) {
		background: var(--muted);
		font-weight: 600;
	}
	.manual :global(h2:focus) {
		outline: none;
	}
</style>
