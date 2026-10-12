<script lang="ts">
	import SyncToggle from '$lib/components/sync-toggle.svelte';
	import type { Call } from '$lib/call';
	import type { SettingsView } from '$lib/settings.svelte';

	/**
	 * 設定の見出しに添える、その設定を同期するかの印。Pro で、設定の同期を入れているときだけ出す。
	 * name は設定の項目名、label は読み上げで設定を見分ける見出し
	 */
	let {
		view,
		name,
		label,
		call
	}: {
		view: SettingsView;
		name: string;
		label: string;
		call: Call;
	} = $props();
</script>

{#if view.proAvailable && view.syncKinds.settings}
	<SyncToggle
		compact
		settingName={name}
		pressed={!view.syncExcludedSettings.includes(name)}
		name={label}
		onchange={(sync) => void call('set_sync_excluded_setting', { name, sync })}
	/>
{/if}
