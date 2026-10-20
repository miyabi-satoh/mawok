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

	/** 目次で塗る、読んでいる節 */
	let current = $state('section-1');
	/**
	 * 目次から移った節。最後の方の短い節は見出しが上端まで来ないので、スクロールの位置から決めると
	 * 押した節と違う節が塗られる。利用者が自分でスクロールするまでは、押した節を塗る
	 */
	let jumped: string | null = null;
	/** 見出しが本文の区画の上端からこの距離に入ったら、その節を読んでいるとみなす (見出しの scroll-margin と揃える) */
	const READING_OFFSET = 24;

	/** 設定ウィンドウと同じく、Esc と Cmd+W（Windows は Ctrl+W）で閉じる */
	function onKeydown(event: KeyboardEvent) {
		jumped = null;
		if (isCloseWindowKey(event, data.platform)) {
			event.preventDefault();
			invoke('close_manual_window');
		}
	}

	/**
	 * 目次から節へ移る。スクロールするのはページではなく本文の区画なので、URL の # に任せず、
	 * 見出しまで送ってフォーカスも移す (読み上げも移った先から続く)
	 */
	function jump(event: MouseEvent, id: string) {
		event.preventDefault();
		const heading = document.getElementById(id);
		if (!heading) return;
		jumped = id;
		current = id;
		heading.scrollIntoView({ block: 'start' });
		heading.focus({ preventScroll: true });
	}

	/** 本文の中の、ほかの節へのリンクも、目次と同じく見出しまで送る */
	function onArticleClick(event: MouseEvent) {
		const link = (event.target as Element).closest('.manual a[href^="#section-"]');
		if (link) jump(event, link.getAttribute('href')!.slice(1));
	}

	function onScroll(event: Event) {
		if (jumped) return;
		const body = event.currentTarget as HTMLElement;
		const top = body.getBoundingClientRect().top + READING_OFFSET;
		let reading: string | undefined = manual.sections[0]?.id;
		for (const { id } of manual.sections) {
			const heading = document.getElementById(id);
			if (heading && heading.getBoundingClientRect().top <= top) reading = id;
		}
		// 末尾まで送ったら、上端まで来られない最後の節を読んでいる
		if (body.scrollTop + body.clientHeight >= body.scrollHeight - 1)
			reading = manual.sections.at(-1)?.id;
		if (reading) current = reading;
	}

	/** ウィンドウは隠して作られるので、画面を描いてから表示させる */
	function showWindow() {
		invoke('show_manual_window');
	}
</script>

<!-- 利用者が自分でスクロールしたら、塗る節をスクロールの位置から決め直す -->
<svelte:window
	onkeydown={onKeydown}
	onclick={onArticleClick}
	onwheel={() => (jumped = null)}
	onpointerdown={() => (jumped = null)}
/>

<main class="flex h-dvh" {@attach showWindow} lang={locale}>
	<!-- 目次は設定の窓のサイドバーと同じ幅と色にする -->
	<nav
		class="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-sidebar-border bg-sidebar p-2"
		aria-label={m.manual_contents()}
	>
		<h1 class="px-2 pt-1 pb-2 text-sm font-semibold">{manual.title}</h1>
		{#each manual.sections as section (section.id)}
			<a
				href="#{section.id}"
				aria-current={current === section.id ? 'location' : undefined}
				class="rounded-md px-2 py-1.5 text-sm leading-snug hover:bg-sidebar-accent/60 aria-[current]:bg-sidebar-accent aria-[current]:font-medium aria-[current]:text-sidebar-accent-foreground"
				onclick={(event) => jump(event, section.id)}>{section.title}</a
			>
		{/each}
	</nav>
	<!-- 本文だけをスクロールし、目次は残す -->
	<div class="min-w-0 flex-1 overflow-y-auto px-8 pt-2 pb-12" onscroll={onScroll}>
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- ソースは同梱の docs/manual/*.md だけで、外から入る文字を含まない -->
		<article class="manual">{@html manual.html}</article>
	</div>
</main>

<style>
	.manual :global(h2) {
		margin-top: 2.5rem;
		font-size: 1.25rem;
		font-weight: 700;
		scroll-margin-top: 1.5rem;
	}
	.manual :global(h2:first-child) {
		margin-top: 1rem;
	}
	.manual :global(h3) {
		margin-top: 1.5rem;
		font-size: 1.125rem;
		font-weight: 600;
	}
	/* 本文はデジタル庁デザインシステムの読み物の本文 (16px・行高 1.75・字間 2%) に合わせる。
	 * 操作の画面 (設定の窓など) の 14px は、読み物の本文には小さい */
	.manual :global(:is(p, ul, ol, .table-scroll)) {
		margin-top: 0.75rem;
		font-size: 1rem;
		line-height: 1.75;
		letter-spacing: 0.02em;
	}
	.manual :global(ul) {
		list-style: disc;
		padding-left: 1.25rem;
	}
	.manual :global(:is(ul, ol) > li + li) {
		margin-top: 0.25rem;
	}
	.manual :global(li::marker) {
		color: var(--muted-foreground);
	}
	/* 手順の番号は、丸の中の数字にして本文から離す */
	.manual :global(ol) {
		counter-reset: step;
		list-style: none;
	}
	.manual :global(ol > li) {
		position: relative;
		padding-left: 2rem;
		counter-increment: step;
	}
	.manual :global(ol > li::before) {
		content: counter(step);
		position: absolute;
		top: 0.2rem;
		left: 0;
		display: grid;
		place-items: center;
		width: 1.375rem;
		height: 1.375rem;
		border-radius: 999px;
		background: var(--primary);
		color: var(--primary-foreground);
		font-size: 0.75rem;
		font-weight: 600;
		line-height: 1;
	}
	.manual :global(li > :is(ul, ol)) {
		margin-top: 0.25rem;
	}
	.manual :global(code) {
		border-radius: 0.25rem;
		background: var(--muted);
		padding: 0.1rem 0.3rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85em;
	}
	/* 隠した + (sr-only) は絶対配置なので、ここを基準にする。基準が無いと窓の全体が基準になり、
	 * 本文の区画の外へ出て、ページごと縦に伸びる */
	.manual :global(.keys) {
		position: relative;
		display: inline-flex;
		font-family: var(--font-sans);
		gap: 0.2rem;
		white-space: nowrap;
	}
	.manual :global(.keys > kbd) {
		min-width: 1.5em;
		padding: 0 0.4em;
		border: 1px solid var(--border);
		border-bottom-width: 2px;
		border-radius: 0.3rem;
		background: var(--background);
		font-family: inherit;
		font-size: 0.8em;
		font-weight: 500;
		line-height: 1.6;
		text-align: center;
	}
	/* 文字の色は本文と同じなので、下線でリンクと分かるようにする (設定の窓のリンクと同じ) */
	.manual :global(a) {
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	.manual :global(a:hover) {
		text-decoration-thickness: 2px;
	}
	.manual :global(strong) {
		font-weight: 600;
	}
	.manual :global(.table-scroll) {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: 0.5rem;
	}
	.manual :global(table) {
		width: 100%;
		border-collapse: collapse;
		/* 表は本文より詰めるが、同じ指針の下限の 14px は割らない */
		font-size: 0.875rem;
		line-height: 1.6;
	}
	.manual :global(:is(th, td)) {
		padding: 0.5rem 0.75rem;
		text-align: left;
		vertical-align: top;
	}
	.manual :global(td) {
		border-top: 1px solid var(--border);
	}
	/* 表の中の `@sh コマンド` などを、狭い列で途中から折り返さない */
	.manual :global(td code) {
		white-space: nowrap;
	}
	.manual :global(th) {
		background: var(--muted);
		font-weight: 600;
	}
	.manual :global(h2:focus) {
		outline: none;
	}
</style>
