<script lang="ts">
	import SettingsRow from '$lib/components/settings-row.svelte';
	import SettingsSection from '$lib/components/settings-section.svelte';
	import SyncChoiceDialog from '$lib/components/sync-choice-dialog.svelte';
	import SyncBackupDialog from '$lib/components/sync-backup-dialog.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import { Switch } from '$lib/components/ui/switch';
	import type { Call } from '$lib/call';
	import { modifiedName } from '$lib/modified-settings';
	import { m } from '$lib/paraglide/messages';
	import type { SettingsView } from '$lib/settings.svelte';

	/** アカウントの同期。種類ごとの切り替えと、食い違いを選ぶ画面を置く。 */
	let {
		view,
		call,
		onopendevices,
		choiceOpen = $bindable(false)
	}: {
		view: SettingsView;
		call: Call;
		onopendevices: () => void;
		choiceOpen: boolean;
	} = $props();
	let backupOpen = $state(false);

	const kinds = [
		{ kind: 'settings', label: m.settings_sync_settings },
		{ kind: 'keys', label: m.settings_sync_keys },
		{ kind: 'replacements', label: m.settings_sync_replacements },
		{ kind: 'snippets', label: m.settings_sync_snippets },
		{ kind: 'actions', label: m.settings_sync_actions },
		{ kind: 'history', label: m.settings_sync_history }
	] as const;
</script>

<SettingsSection title={m.settings_section_sync()}>
	{#if view.accountKeyStatus === 'needsPairing'}
		<SettingsRow>
			<p class="text-sm">{m.settings_sync_needs_pairing()}</p>
			<Button variant="outline" size="sm" class="w-fit" onclick={onopendevices}>
				{m.settings_sync_open_devices()}
			</Button>
		</SettingsRow>
	{/if}
	{#each kinds as { kind, label } (kind)}
		<SettingsRow modified={modifiedName(view, `sync_${kind}`)}>
			<Field.Field orientation="horizontal" class="min-h-8">
				<Field.Label for="sync-{kind}">{label()}</Field.Label>
				<Switch
					id="sync-{kind}"
					bind:checked={
						() => view.syncKinds[kind], (enabled) => void call('set_sync_kind', { kind, enabled })
					}
				/>
			</Field.Field>
		</SettingsRow>
	{/each}
	<SettingsRow>
		<Button variant="outline" size="sm" class="w-fit" onclick={() => (backupOpen = true)}>
			{m.settings_sync_restore_open()}
		</Button>
	</SettingsRow>
	{#if view.syncConflicts > 0}
		<SettingsRow>
			<p class="text-sm">{m.settings_sync_choice_notice()}</p>
			<Button variant="outline" size="sm" class="w-fit" onclick={() => (choiceOpen = true)}>
				{m.settings_sync_choice_open()}
			</Button>
		</SettingsRow>
	{/if}
</SettingsSection>

<SyncChoiceDialog bind:open={choiceOpen} platform={view.platform} />
<SyncBackupDialog bind:open={backupOpen} locale={view.locale} />
