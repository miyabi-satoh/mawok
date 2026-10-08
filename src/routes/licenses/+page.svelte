<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { invoke } from '@tauri-apps/api/core';
	import { isCloseWindowKey } from '$lib/keys';
	import { m } from '$lib/paraglide/messages';
	import { SvelteSet } from 'svelte/reactivity';
	import type { LicenseList, LicensePackage } from './+page';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let sections = $derived([
		{ key: 'rust', title: m.licenses_section_app(), list: data.rust },
		{ key: 'npm', title: m.licenses_section_frontend(), list: data.npm }
	]);

	/**
	 * 開いている行。本文は数百件あり長いので、開いた行の分だけ描く。
	 * Rust と npm で同じ名前のパッケージがありうるので、区画の名前を添えて区別する。
	 */
	const opened = new SvelteSet<string>();

	function onToggle(event: Event, key: string) {
		if ((event.currentTarget as HTMLDetailsElement).open) opened.add(key);
		else opened.delete(key);
	}

	function textsOf(list: LicenseList, pkg: LicensePackage) {
		return pkg.texts.map((index) => list.texts[index]);
	}

	/** 設定ウィンドウと同じく、Esc と Cmd+W（Windows は Ctrl+W）で閉じる */
	function onKeydown(event: KeyboardEvent) {
		if (isCloseWindowKey(event, data.platform)) {
			event.preventDefault();
			invoke('close_licenses_window');
		}
	}

	/**
	 * ソースの置き場所は既定のブラウザーで開く。ウィンドウの中で開くと、アプリの画面がそのページに
	 * 置き換わって戻れなくなるため
	 */
	function openSource(event: MouseEvent, url: string) {
		event.preventDefault();
		invoke('open_license_source', { url });
	}

	/** ウィンドウは隠して作られるので、画面を描いてから表示させる */
	function showWindow() {
		invoke('show_licenses_window');
	}
</script>

<svelte:window onkeydown={onKeydown} />

<main class="h-dvh overflow-y-auto px-6 py-6" {@attach showWindow}>
	<h1 class="text-lg font-semibold">{m.licenses_title()}</h1>
	<p class="mt-2 text-sm leading-snug text-muted-foreground">{m.licenses_lead()}</p>

	{#each sections as section (section.key)}
		<section class="mt-8">
			<h2 class="text-base font-semibold">{section.title}</h2>
			{#if section.list === null}
				<p class="mt-2 text-sm text-muted-foreground">{m.licenses_unavailable()}</p>
			{:else}
				{@const list = section.list}
				<ul class="mt-2 divide-y rounded-md border">
					{#each list.packages as pkg (pkg.name)}
						{@const key = `${section.key}:${pkg.name}`}
						<li>
							<details class="group" ontoggle={(event) => onToggle(event, key)}>
								<!-- 開閉の印は自前で置く。summary を flex にすると既定の三角が消えるため -->
								<summary
									class="flex items-baseline gap-2 px-3 py-2 text-sm select-none hover:bg-muted/50"
								>
									<ChevronRightIcon
										class="size-4 shrink-0 self-center transition-transform group-open:rotate-90"
										strokeWidth={1.5}
									/>
									<!-- 下線の後ろでも折れるようにする。ハイフンと違い、下線では折れないので、
									     windows_x86_64_msvc のような名前がライセンスの欄を枠の外へ押し出す -->
									<span class="font-medium"
										>{#each pkg.name.split(/(?<=_)/) as part, i (i)}{#if i > 0}<wbr
												/>{/if}{part}{/each}</span
									>
									<span class="text-muted-foreground">{pkg.versions.join(', ')}</span>
									<!-- 幅に上限を付け、長い式（rustix の「Apache-2.0 WITH LLVM-exception OR …」）は語の間で折る。
									     上限が無いと最小幅で枠の外へはみ出す。Apache-2.0 のような識別子はハイフンで折らない -->
									<span class="ml-auto max-w-3/5 shrink-0 pl-4 text-right text-muted-foreground">
										{#each pkg.license.split(' ') as part, i (i)}{i > 0 ? ' ' : ''}<span
												class="whitespace-nowrap">{part}</span
											>{/each}
									</span>
								</summary>
								{#if opened.has(key)}
									<div class="space-y-3 px-3 pb-3">
										{#if pkg.repository !== null}
											<!-- ソースの置き場所を出す。MPL-2.0 のパッケージが入っており、
											     受け取る人にソースの入手先を知らせる必要があるため。
											     リンクは開閉の summary の外に置く。中に置くと、押したときに開閉とリンクのどちらが
											     働くかが紛らわしく、支援技術にも扱いにくい -->
											<p class="text-sm">
												{m.licenses_source()}:
												<a
													href={pkg.repository}
													rel="external"
													class="break-all text-primary underline underline-offset-2 hover:decoration-2"
													onclick={(event) => openSource(event, pkg.repository!)}
												>
													{pkg.repository}
												</a>
											</p>
										{/if}
										{#each textsOf(list, pkg) as text, index (index)}
											<div>
												<h3 class="text-xs font-semibold text-muted-foreground">{text.name}</h3>
												<p
													class="mt-1 rounded-md bg-muted px-3 py-2 text-xs leading-relaxed wrap-break-word whitespace-pre-wrap"
												>
													{text.text}
												</p>
											</div>
										{/each}
									</div>
								{/if}
							</details>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/each}
</main>
