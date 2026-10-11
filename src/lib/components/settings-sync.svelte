<script lang="ts">
	import SettingsRow from '$lib/components/settings-row.svelte';
	import SettingsSection from '$lib/components/settings-section.svelte';
	import SyncChoiceDialog from '$lib/components/sync-choice-dialog.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import { Switch } from '$lib/components/ui/switch';
	import type { Call } from '$lib/call';
	import { m } from '$lib/paraglide/messages';
	import type { SettingsView } from '$lib/settings.svelte';

	/**
	 * 設定の「アカウント」の「同期」のまとまり（docs/sync.md 冒頭・「食い違い」）。
	 * choiceOpen は、どちらを使うか選ぶ画面を出しているか。トレイから頼まれたときは、呼んだ側が開く
	 */
	let {
		view,
		call,
		choiceOpen = $bindable(false)
	}: { view: SettingsView; call: Call; choiceOpen: boolean } = $props();
</script>

<SettingsSection title={m.settings_section_sync()}>
	<SettingsRow>
		<Field.Field orientation="horizontal" class="min-h-8">
			<Field.Label for="sync-settings">{m.settings_sync_settings()}</Field.Label>
			<Switch
				id="sync-settings"
				bind:checked={
					() => view.syncSettings, (enabled) => void call('set_sync_settings', { enabled })
				}
			/>
		</Field.Field>
	</SettingsRow>
	<SettingsRow>
		<Field.Field orientation="horizontal" class="min-h-8">
			<Field.Label for="sync-history">{m.settings_sync_history()}</Field.Label>
			<Switch
				id="sync-history"
				bind:checked={
					() => view.syncHistory, (enabled) => void call('set_sync_history', { enabled })
				}
			/>
		</Field.Field>
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
