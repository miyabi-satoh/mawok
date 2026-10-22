<script lang="ts">
	import SettingsRow from '$lib/components/settings-row.svelte';
	import SettingsSection from '$lib/components/settings-section.svelte';
	import SyncPasswordForm from '$lib/components/sync-password-form.svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import { Switch } from '$lib/components/ui/switch';
	import type { SyncKind } from '$lib/bindings/SyncKind';
	import type { Call } from '$lib/call';
	import { modifiedName } from '$lib/modified-settings';
	import { m } from '$lib/paraglide/messages';
	import type { SettingsView } from '$lib/settings.svelte';
	import { syncPanel } from '$lib/sync-password';

	/**
	 * アカウントの同期。同期のパスワード（始める・入れる・変える・リセット）と、種類ごとの切り替えを置く
	 * （docs/sync.md「同期のパスワード」）。onfailure は、欄に出さない失敗を画面のエラーの帯に出す
	 */
	let {
		view,
		call,
		onfailure
	}: {
		view: SettingsView;
		call: Call;
		onfailure: (error: unknown) => void;
	} = $props();
	let resetOpen = $state(false);
	/** 「同期をリセット」を確かめて、新しいパスワードを作っている途中か */
	let resetting = $state(false);
	/** 同期のパスワードを変える欄を出しているか */
	let changing = $state(false);
	/** パスワードを変え終えた知らせを出すか。次に操作するまで出しておく */
	let changed = $state(false);
	const panel = $derived(syncPanel(view.syncKeyStatus, resetting));
	/**
	 * 作る・入れる欄を開いた状態。1台につき一度きりなので、ボタンで開くまで欄を出さない。
	 * 開いた欄で持ち、状態が移って欄が替わったら閉じた扱いになる
	 */
	let opened = $state<'create' | 'enter' | null>(null);

	// 同期していない状態に移ったら（ほかのデバイスのリセットなど）、書きかけの変更の欄と、変え終えた知らせを片付ける。
	// 入れ直して戻ったときに、前の欄や知らせが残って見えないため
	$effect(() => {
		if (view.syncKeyStatus === 'ready') return;
		changing = false;
		changed = false;
	});

	const kinds = [
		{ kind: 'settings', label: m.settings_sync_settings },
		{ kind: 'keys', label: m.settings_sync_keys },
		{ kind: 'replacements', label: m.settings_sync_replacements },
		{ kind: 'snippets', label: m.settings_sync_snippets },
		{ kind: 'history', label: m.settings_sync_history }
	] as const satisfies readonly { kind: SyncKind; label: () => string }[];

	function confirmReset() {
		resetOpen = false;
		opened = null;
		changing = false;
		changed = false;
		resetting = true;
	}
</script>

<SettingsSection title={m.settings_section_sync()}>
	{#if panel === 'create' && (resetting || opened === 'create')}
		<SettingsRow>
			<SyncPasswordForm
				mode="create"
				replace={resetting}
				{onfailure}
				ondone={() => {
					resetting = false;
					opened = null;
				}}
				oncancel={() => {
					resetting = false;
					opened = null;
				}}
			/>
		</SettingsRow>
	{:else if panel === 'enter' && opened === 'enter'}
		<SettingsRow>
			<SyncPasswordForm
				mode="enter"
				{onfailure}
				ondone={() => (opened = null)}
				oncancel={() => (opened = null)}
				onforgot={() => (resetOpen = true)}
			/>
		</SettingsRow>
	{:else if panel === 'create' || panel === 'enter'}
		<SettingsRow>
			<Field.Content>
				<!-- 狭いときは、題名を折らずに操作を次の行へ回す -->
				<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
					<Field.Title>
						{panel === 'create' ? m.settings_sync_start_title() : m.settings_sync_join_title()}
					</Field.Title>
					<Button variant="outline" size="sm" onclick={() => (opened = panel)}>
						{panel === 'create'
							? m.settings_sync_password_create()
							: m.settings_sync_password_enter()}
					</Button>
				</Field.Field>
				<Field.Description class="leading-snug">
					{panel === 'create'
						? m.settings_sync_start_description()
						: m.settings_sync_join_description()}
				</Field.Description>
			</Field.Content>
		</SettingsRow>
	{:else}
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
		{#if view.syncKeyStatus === 'ready'}
			<SettingsRow>
				{#if changing}
					<SyncPasswordForm
						mode="change"
						{onfailure}
						ondone={() => {
							changing = false;
							changed = true;
						}}
						oncancel={() => (changing = false)}
					/>
				{:else}
					<!-- 狭いときは、題名を折らずに操作を次の行へ回す -->
					<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
						<Field.Title>{m.settings_sync_password_row()}</Field.Title>
						<div class="flex items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								onclick={() => {
									changed = false;
									changing = true;
								}}
							>
								{m.settings_sync_password_change()}
							</Button>
							<Button variant="outline" size="sm" onclick={() => (resetOpen = true)}>
								{m.settings_sync_reset()}
							</Button>
						</div>
					</Field.Field>
					{#if changed}
						<Field.Description role="status">{m.settings_sync_password_changed()}</Field.Description
						>
					{/if}
				{/if}
			</SettingsRow>
		{/if}
	{/if}
</SettingsSection>

<AlertDialog.Root bind:open={resetOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.settings_sync_reset_confirm_title()}</AlertDialog.Title>
			<AlertDialog.Description
				>{m.settings_sync_reset_confirm_description()}</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.common_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" onclick={confirmReset}>
				{m.settings_sync_reset_confirm_start()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
