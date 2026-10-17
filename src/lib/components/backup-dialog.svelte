<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { restoreChangeText } from '$lib/backup-changes';
	import type { Backup } from '$lib/bindings/Backup';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { errorCode } from '$lib/errors';
	import { OpenLoader } from '$lib/open-loader.svelte';
	import { m } from '$lib/paraglide/messages';
	import type { Locale } from '$lib/paraglide/runtime';

	/**
	 * バックアップから戻す（docs/config.md「バックアップ」）。新しい順に並べ、戻すと今の設定から変わる所を添える。
	 * 一覧が長くても窓に収まるよう、題名とボタンを残して中身だけを送る
	 */
	let { open = $bindable(false), locale }: { open: boolean; locale: Locale } = $props();
	let backups = $state<Backup[] | null>(null);
	let selected = $state<string | null>(null);
	let notice = $state('');
	let restoring = $state(false);
	const loader = new OpenLoader(
		() => open,
		() => load()
	);

	const date = (name: string) => {
		const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json$/.exec(name);
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
		errorCode(error) === 'backup.restore_partial'
			? m.backup_restore_partial()
			: m.settings_failed({ error: errorCode(error) });

	async function load(message = '') {
		const current = loader.begin();
		backups = null;
		selected = null;
		notice = message;
		try {
			const result = await invoke<Backup[]>('settings_backups');
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
			await invoke('restore_settings_backup', { name: selected });
			open = false;
		} catch (error) {
			const message = failure(error);
			if (errorCode(error) === 'backup.restore_partial') await load(message);
			else notice = message;
		} finally {
			restoring = false;
		}
	}
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Content
		class="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg"
	>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.backup_restore_title()}</AlertDialog.Title>
		</AlertDialog.Header>
		<div class="-mx-4 flex flex-col gap-4 overflow-y-auto px-4">
			<p class="text-sm text-muted-foreground">{m.backup_restore_description()}</p>
			{#if notice}
				<p role="status" class="text-sm">{notice}</p>
			{/if}
			{#if backups === null}
				<p role="status" class="text-sm text-muted-foreground">{m.backup_loading()}</p>
			{:else if backups.length === 0}
				<p class="text-sm text-muted-foreground">{m.backup_restore_empty()}</p>
			{/if}
			{#each backups ?? [] as backup (backup.name)}
				{@const changes = restoreChangeText(backup.changes, locale)}
				{@const same = backup.changes.length === 0}
				<label
					class="flex gap-3 rounded-lg border p-3 text-sm has-checked:border-primary has-focus-visible:ring-3 has-focus-visible:ring-ring/50 {same
						? 'text-muted-foreground'
						: 'cursor-pointer'}"
				>
					<!-- 今と同じ設定には、戻しても何も変わらないので選ばせない -->
					<input
						type="radio"
						name="settings-backup"
						value={backup.name}
						disabled={restoring || same}
						bind:group={selected}
					/>
					<span class="flex min-w-0 flex-col gap-1">
						<span>{date(backup.name)}</span>
						{#if same}<span>{m.backup_restore_same()}</span>{/if}
						{#if changes.changes}<span class="text-muted-foreground">{changes.changes}</span>{/if}
						{#if changes.removes}<span class="text-muted-foreground">{changes.removes}</span>{/if}
						{#if changes.bringsBack}<span class="text-muted-foreground">{changes.bringsBack}</span
							>{/if}
					</span>
				</label>
			{/each}
		</div>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={restoring}>{m.common_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action disabled={restoring || !selected} onclick={restore}>
				{m.backup_restore_confirm()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
