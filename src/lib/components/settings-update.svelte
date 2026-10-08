<script lang="ts">
	import { listen } from '@tauri-apps/api/event';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import SettingsRow from '$lib/components/settings-row.svelte';
	import { EVENTS } from '$lib/bindings/constants';
	import type { UpdateView } from '$lib/bindings/UpdateView';
	import type { Call } from '$lib/call';
	import { m } from '$lib/paraglide/messages';
	import { updateButton, updateStatusText } from '$lib/update-status';

	/** Mac 版の更新の行（docs/platform.md「Mac 版の更新」）。確かめるのも入れるのも Rust 側で、ここは様子を出して頼むだけ */
	let { call }: { call: Call } = $props();

	/** Rust 側から受け取った様子。読み終えるまでは null で、行を出さない */
	let view = $state<UpdateView | null>(null);
	const text = $derived(view ? updateStatusText(view.status) : '');
	const button = $derived(view ? updateButton(view.status) : null);

	// 先に待ち受けてから今の様子を読む。読んだ後の変わり目は知らせで届く。
	// 読む間に知らせが届いていたら、そちらが新しいので、読んだ様子では上書きしない
	$effect(() => {
		const unlisten = listen<UpdateView>(EVENTS.UPDATE_CHANGED, (event) => (view = event.payload));
		unlisten.then(async () => {
			const result = await call<UpdateView>('update_status');
			if (result.ok && view === null) view = result.value;
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	});
</script>

{#if view}
	<SettingsRow>
		<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
			<Field.Title>{m.settings_update()}</Field.Title>
			<div class="flex flex-wrap items-center gap-2">
				<span role="status" class="text-sm text-muted-foreground">{text}</span>
				{#if button === 'check'}
					<Button variant="outline" size="sm" onclick={() => call('check_for_update')}>
						{m.settings_update_check()}
					</Button>
				{:else if button === 'install' || button === 'installing'}
					<Button
						variant="outline"
						size="sm"
						disabled={button === 'installing'}
						onclick={() => call('install_update')}
					>
						{m.settings_update_install()}
					</Button>
				{/if}
			</div>
		</Field.Field>
		{#if button === 'install' && view.draftHasText}
			<Field.Description class="leading-snug">{m.settings_update_draft_lost()}</Field.Description>
		{/if}
	</SettingsRow>
{/if}
