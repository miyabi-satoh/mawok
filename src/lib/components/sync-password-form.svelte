<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { m } from '$lib/paraglide/messages';
	import {
		MIN_SYNC_PASSWORD_CHARS,
		newPasswordErrors,
		syncPasswordFailure,
		syncStateChanged,
		type SyncPasswordErrors
	} from '$lib/sync-password';

	/**
	 * 同期のパスワードの欄（docs/sync.md「同期のパスワード」）。
	 * create は「同期を開始」と「同期をリセット」、enter はほかのデバイスで始めた同期に加わるとき、change は変えるとき。
	 * 欄に関わる失敗は欄の下に出し、ほかの失敗は onfailure に渡す（画面のエラーの帯に出す）。
	 * 窓口の状態が変わっていたら（ほかのデバイスが始めた・リセットした）、oncancel で欄を閉じ、今の状態の欄に任せる。
	 * replace は create のときだけ使い、窓口の写しを消して始め直す（「同期をリセット」）か
	 */
	let {
		mode,
		onfailure,
		ondone,
		oncancel,
		onforgot,
		replace = false
	}: {
		mode: 'create' | 'enter' | 'change';
		replace?: boolean;
		onfailure: (error: unknown) => void;
		ondone?: () => void;
		oncancel?: () => void;
		onforgot?: () => void;
	} = $props();

	const id = $props.id();
	let values = $state({ current: '', password: '', confirm: '' });
	let errors = $state<SyncPasswordErrors>({});
	/** 窓口とやり取りしている間。パスワードから鍵を作る（Argon2id）ので1秒ほどかかる */
	let busy = $state(false);

	const title = $derived(
		mode === 'create'
			? m.settings_sync_password_create_title()
			: mode === 'enter'
				? m.settings_sync_password_enter_title()
				: m.settings_sync_password_change_title()
	);
	const filled = $derived(
		values.password !== '' &&
			(mode === 'enter' || values.confirm !== '') &&
			(mode !== 'change' || values.current !== '')
	);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const { current, password, confirm } = values;
		errors = mode === 'enter' ? {} : newPasswordErrors(password, confirm);
		if (Object.keys(errors).length > 0) return;
		busy = true;
		try {
			if (mode === 'create') await invoke('start_sync', { password, replace });
			else if (mode === 'enter') await invoke('unlock_sync', { password });
			else await invoke('change_sync_password', { current, password });
		} catch (error) {
			busy = false;
			if (syncStateChanged(error)) {
				oncancel?.();
				return;
			}
			const fieldErrors = syncPasswordFailure(error, mode === 'change' ? 'current' : 'password');
			if (fieldErrors) errors = fieldErrors;
			else onfailure(error);
			return;
		}
		busy = false;
		ondone?.();
	}
</script>

{#snippet passwordField(
	field: 'current' | 'password' | 'confirm',
	label: string,
	autocomplete: 'current-password' | 'new-password',
	hint?: string
)}
	<Field.Field>
		<Field.Label for="{id}-{field}">{label}</Field.Label>
		<Input
			id="{id}-{field}"
			class="max-w-72"
			type="password"
			{autocomplete}
			aria-invalid={errors[field] ? true : undefined}
			bind:value={values[field]}
		/>
		{#if hint}
			<Field.Description>{hint}</Field.Description>
		{/if}
		{#if errors[field]}
			<Field.Error>{errors[field]}</Field.Error>
		{/if}
	</Field.Field>
{/snippet}

<form class="flex flex-col gap-3" aria-label={title} onsubmit={submit}>
	<Field.Title>{title}</Field.Title>
	{#if mode === 'create'}
		{@render passwordField(
			'password',
			m.settings_sync_password(),
			'new-password',
			m.settings_sync_password_hint({ count: MIN_SYNC_PASSWORD_CHARS })
		)}
		{@render passwordField('confirm', m.settings_sync_password_confirm(), 'new-password')}
		<p class="text-sm text-muted-foreground">{m.settings_sync_password_warning()}</p>
	{:else if mode === 'enter'}
		{@render passwordField('password', m.settings_sync_password(), 'current-password')}
	{:else}
		{@render passwordField('current', m.settings_sync_password_current(), 'current-password')}
		{@render passwordField('password', m.settings_sync_password_new(), 'new-password')}
		{@render passwordField('confirm', m.settings_sync_password_new_confirm(), 'new-password')}
	{/if}
	<div class="flex flex-wrap items-center gap-2">
		<Button type="submit" class="w-fit" disabled={busy || !filled}>
			{mode === 'change' ? m.settings_sync_password_save() : m.settings_sync_start()}
		</Button>
		{#if oncancel}
			<Button type="button" variant="ghost" disabled={busy} onclick={oncancel}>
				{m.common_cancel()}
			</Button>
		{/if}
		{#if onforgot}
			<Button type="button" variant="link" disabled={busy} onclick={onforgot}>
				{m.settings_sync_password_forgot()}
			</Button>
		{/if}
	</div>
</form>
