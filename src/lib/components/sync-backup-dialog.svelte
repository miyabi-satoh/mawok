<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import SyncDialogFrame from '$lib/components/sync-dialog-frame.svelte';
	import type { SyncBackup } from '$lib/bindings/SyncBackup';
	import { errorCode } from '$lib/errors';
	import { OpenLoader } from '$lib/open-loader.svelte';
	import { m } from '$lib/paraglide/messages';
	import type { Locale } from '$lib/paraglide/runtime';
	import { restoreChangeText } from '$lib/sync-choices';

	let { open = $bindable(false), locale }: { open: boolean; locale: Locale } = $props();
	let backups = $state<SyncBackup[] | null>(null);
	let selected = $state<string | null>(null);
	let notice = $state('');
	let restoring = $state(false);
	const loader = new OpenLoader(
		() => open,
		() => load()
	);

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

	async function load(message = '') {
		const current = loader.begin();
		backups = null;
		selected = null;
		notice = message;
		try {
			const result = await invoke<SyncBackup[]>('sync_backups');
			if (current()) backups = result;
		} catch (error) {
			if (current()) {
				backups = [];
				notice = failure(error);
			}
		}
	}

	async function restore() {
		if (!selected) return;
		restoring = true;
		notice = '';
		try {
			await invoke('restore_sync_backup', { name: selected });
			open = false;
		} catch (error) {
			const message = failure(error);
			if (errorCode(error) === 'sync.restore_partial') await load(message);
			else notice = message;
		} finally {
			restoring = false;
		}
	}
</script>

<SyncDialogFrame
	bind:open
	title={m.sync_restore_title()}
	description={m.sync_restore_description()}
	{notice}
	loading={backups === null}
	busy={restoring}
	actionLabel={m.sync_restore_confirm()}
	actionDisabled={!selected}
	onaction={restore}
>
	{#if backups?.length === 0}
		<p class="text-sm text-muted-foreground">{m.sync_restore_empty()}</p>
	{:else}
		{#each backups ?? [] as backup (backup.name)}
			{@const changes = restoreChangeText(backup.changes, locale)}
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
				<span class="flex min-w-0 flex-col gap-1">
					<span>{date(backup.name)}</span>
					{#if changes.changes}<span class="text-muted-foreground">{changes.changes}</span>{/if}
					{#if changes.removes}<span class="text-muted-foreground">{changes.removes}</span>{/if}
					{#if changes.bringsBack}<span class="text-muted-foreground">{changes.bringsBack}</span
						>{/if}
				</span>
			</label>
		{/each}
	{/if}
</SyncDialogFrame>
