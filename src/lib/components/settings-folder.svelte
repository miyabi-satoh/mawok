<script lang="ts">
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { invoke } from '@tauri-apps/api/core';
	import type { PickedSettingsDir } from '$lib/bindings/PickedSettingsDir';
	import type { Call } from '$lib/call';
	import SettingsRow from '$lib/components/settings-row.svelte';
	import * as Alert from '$lib/components/ui/alert';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import { settingsFolderProblem, settingsProblemNotice } from '$lib/errors';
	import { m } from '$lib/paraglide/messages';
	import type { SettingsView } from '$lib/settings.svelte';

	/**
	 * 設定の保存先の行（docs/config.md「置き場」）。替えた先に設定があれば、そちらを使うか、このデバイスの設定で上書きするかを聞く。
	 * 替えた結果は settings-changed で届く
	 */
	let { view, call }: { view: SettingsView; call: Call } = $props();

	/** 聞いている替え先。path が null なら既定の置き場で、shown はそのとき画面に出す場所 */
	let pending = $state<{ path: string | null; shown: string } | null>(null);
	let busy = $state(false);
	let error = $state('');

	async function change() {
		error = '';
		// 選ぶ窓が開いている間は押せなくする。OS によっては窓が設定の窓をふさがず、もう一度押すと2つ目が開く
		busy = true;
		const picked = await call<PickedSettingsDir | null>('pick_settings_dir');
		busy = false;
		if (!picked.ok || !picked.value || picked.value.path === view.settingsDir) return;
		ask(picked.value.path, picked.value);
	}

	async function resetToDefault() {
		error = '';
		// 既定の保存先の symlink の先を読む許可を求められ、取り消したら null
		busy = true;
		const target = await call<PickedSettingsDir | null>('default_settings_dir');
		busy = false;
		if (target.ok && target.value) ask(null, target.value);
	}

	/** 替え先に設定が無ければ、聞かずにこのデバイスの設定を書いて替える */
	function ask(path: string | null, target: PickedSettingsDir) {
		if (target.hasSettings) pending = { path, shown: target.shownPath };
		else void move(path, false);
	}

	async function move(path: string | null, useExisting: boolean) {
		pending = null;
		busy = true;
		try {
			await invoke('set_settings_dir', { path, useExisting });
		} catch (e) {
			error = settingsFolderProblem(e);
		} finally {
			busy = false;
		}
	}

	/** symlink の先を読む許可を、先の入っているフォルダーで開く窓で求める。許可したら settings-changed で知らせが消える */
	async function grantAccess() {
		error = '';
		busy = true;
		await call('grant_settings_access');
		busy = false;
	}
</script>

<!-- 節の見出しが「設定の保存先」なので、行の題は付けず、今の場所と操作だけを出す -->
<SettingsRow>
	<!-- 長いパスも窓に収まるよう、どこででも折り返す。写して使えるよう選べるようにする -->
	<p class="font-mono text-sm wrap-anywhere select-text" data-testid="settings-folder-path">
		{view.settingsDir}
	</p>
	<Field.Field orientation="horizontal" class="flex-wrap">
		<div class="flex flex-wrap items-center gap-2">
			<Button variant="outline" size="sm" disabled={busy} onclick={change}>
				{m.settings_folder_change()}
			</Button>
			<Button
				variant="outline"
				size="sm"
				aria-label={{
					macos: m.settings_folder_reveal_macos,
					windows: m.settings_folder_reveal_windows,
					linux: m.settings_folder_reveal_linux
				}[view.platform]()}
				onclick={() => call('reveal_settings_dir')}
			>
				{{
					macos: m.settings_reveal_macos,
					windows: m.settings_reveal_windows,
					linux: m.settings_reveal_linux
				}[view.platform]()}
			</Button>
			{#if !view.settingsDirIsDefault}
				<Button variant="outline" size="sm" disabled={busy} onclick={resetToDefault}>
					{m.settings_folder_reset()}
				</Button>
			{/if}
		</div>
	</Field.Field>
	{#if error}
		<Field.Error>{error}</Field.Error>
	{/if}
	<!-- 設定の保存先の問題の知らせ。トレイの ⚠ の項目から開いて読む。説明でなく今の状態なので、警告として出す。
	     読む許可が無いとき (macOS のサンドボックス。docs/config.md「macOS のサンドボックス」) は、許可を求めるボタンも出す -->
	{#if view.settingsProblem}
		<Alert.Root variant="destructive">
			<CircleAlertIcon />
			<Alert.Title class="wrap-anywhere">
				{settingsProblemNotice(view.settingsProblem, view.settingsDir)}
			</Alert.Title>
		</Alert.Root>
		{#if view.settingsProblem.kind === 'accessNeeded'}
			<div>
				<Button variant="outline" size="sm" disabled={busy} onclick={grantAccess}>
					{m.settings_folder_grant_access()}
				</Button>
			</div>
		{/if}
	{/if}
</SettingsRow>

<AlertDialog.Root
	bind:open={
		() => pending !== null,
		(open) => {
			if (!open) pending = null;
		}
	}
>
	<AlertDialog.Content class="data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg">
		<AlertDialog.Header>
			<AlertDialog.Title>{m.settings_folder_has_settings_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.settings_folder_has_settings_description()}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<p class="font-mono text-sm wrap-anywhere select-text">{pending?.shown}</p>
		<AlertDialog.Footer class="sm:flex-wrap">
			<AlertDialog.Cancel>{m.common_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				onclick={() => pending && move(pending.path, false)}
			>
				{m.settings_folder_overwrite()}
			</AlertDialog.Action>
			<AlertDialog.Action onclick={() => pending && move(pending.path, true)}>
				{m.settings_folder_use_existing()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
