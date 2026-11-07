<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { ERROR_CODES } from '$lib/bindings/constants';
	import type { PickedSettingsDir } from '$lib/bindings/PickedSettingsDir';
	import type { Call } from '$lib/call';
	import SettingsRow from '$lib/components/settings-row.svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import { errorCode } from '$lib/errors';
	import { m } from '$lib/paraglide/messages';
	import type { SettingsView } from '$lib/settings.svelte';

	/**
	 * 設定の置き場の行（docs/config.md「置き場」）。替えた先に設定があれば、そちらを使うか、このデバイスの設定で上書きするかを聞く。
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
		const target = await call<PickedSettingsDir>('default_settings_dir');
		if (target.ok) ask(null, target.value);
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
			const code = errorCode(e);
			error =
				code === ERROR_CODES.SETTINGS_FILE_UNREADABLE
					? m.settings_folder_unreadable()
					: code === ERROR_CODES.SETTINGS_FOLDER_UNAVAILABLE
						? m.settings_folder_link_missing()
						: m.settings_failed({ error: code });
		} finally {
			busy = false;
		}
	}
</script>

<SettingsRow>
	<!-- 狭いときは、題名を折らずに操作を次の行へ回す -->
	<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
		<Field.Title>{m.settings_folder()}</Field.Title>
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
	<!-- 長いパスも窓に収まるよう、どこででも折り返す。写して使えるよう選べるようにする -->
	<p class="font-mono text-sm wrap-anywhere select-text" data-testid="settings-folder-path">
		{view.settingsDir}
	</p>
	{#if error}
		<Field.Error>{error}</Field.Error>
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
