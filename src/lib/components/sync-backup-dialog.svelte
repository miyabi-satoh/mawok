<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { untrack } from 'svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import type { SyncBackup } from '$lib/bindings/SyncBackup';
	import { errorCode } from '$lib/errors';
	import { m } from '$lib/paraglide/messages';
	import type { Locale } from '$lib/paraglide/runtime';
	import { restoreChangeText } from '$lib/sync-choices';

	let { open = $bindable(false), locale }: { open: boolean; locale: Locale } = $props();
	let backups = $state<SyncBackup[] | null>(null);
	let selected = $state<string | null>(null);
	let notice = $state('');
	let restoring = $state(false);
	let loads = 0;

	const date = (name: string) => {
		const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.toml$/.exec(name);
		if (!match) return name;
		const [, year, month, day, hour, minute, second] = match;
		return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			second: '2-digit'
		}).format(new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second)));
	};

	const failure = (error: unknown) =>
		errorCode(error) === 'sync.restore_partial'
			? m.sync_restore_partial()
			: m.settings_failed({ error: errorCode(error) });

	async function load() {
		const load = ++loads;
		backups = null;
		selected = null;
		notice = '';
		try {
			const result = await invoke<SyncBackup[]>('sync_backups');
			if (load === loads) backups = result;
		} catch (error) {
			if (load === loads) {
				backups = [];
				notice = failure(error);
			}
		}
	}

	$effect(() => {
		if (open) untrack(() => void load());
		else loads++;
	});

	async function restore() {
		if (!selected) return;
		restoring = true;
		notice = '';
		try {
			await invoke('restore_sync_backup', { name: selected });
			open = false;
		} catch (error) {
			notice = failure(error);
		} finally {
			restoring = false;
		}
	}
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Content
		class="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg"
	>
		<AlertDialog.Header
			><AlertDialog.Title>{m.sync_restore_title()}</AlertDialog.Title></AlertDialog.Header
		>
		<div class="-mx-4 flex flex-col gap-4 overflow-y-auto px-4">
			<p class="text-sm text-muted-foreground">{m.sync_restore_description()}</p>
			{#if notice}<p role="status" class="text-sm">{notice}</p>{/if}
			{#if backups === null}
				<p role="status" class="text-sm text-muted-foreground">{m.sync_restore_loading()}</p>
			{:else if backups.length === 0}
				<p class="text-sm text-muted-foreground">{m.sync_restore_empty()}</p>
			{:else}
				{#each backups as backup (backup.name)}
					<label
						class="flex cursor-pointer gap-3 rounded-lg border p-3 text-sm has-checked:border-primary has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
					>
						<input
							type="radio"
							name="sync-backup"
							value={backup.name}
							disabled={restoring}
							bind:group={selected}
						/>
						<span class="flex min-w-0 flex-col gap-1"
							><span>{date(backup.name)}</span><span class="text-muted-foreground"
								>{restoreChangeText(backup.changes, locale)}</span
							></span
						>
					</label>
				{/each}
			{/if}
		</div>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={restoring}>{m.sync_choice_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action disabled={restoring || !selected} onclick={restore}
				>{m.sync_restore_confirm()}</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
