<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import PasswordInput from '$lib/components/password-input.svelte';
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
	 * create は「同期を始める」とき、enter はほかのデバイスで始めた同期に加わるとき、change は変えるとき。
	 * 欄に関わる失敗は欄の下に出し、ほかの失敗は onfailure に渡す（画面のエラーの帯に出す）。
	 * 窓口の状態が変わっていたら（ほかのデバイスが始めた・同期データを削除した）、oncancel で欄を閉じ、今の状態の欄に任せる。
	 */
	let {
		mode,
		onfailure,
		ondone,
		oncancel
	}: {
		mode: 'create' | 'enter' | 'change';
		onfailure: (error: unknown) => void;
		ondone?: () => void;
		oncancel?: () => void;
	} = $props();

	const id = $props.id();
	let values = $state({ current: '', password: '', confirm: '' });
	let errors = $state<SyncPasswordErrors>({});
	/** 窓口とやり取りしている間。パスワードから鍵を作る（Argon2id）ので1秒ほどかかる */
	let busy = $state(false);

	const title = $derived(
		mode === 'create'
			? m.settings_sync_start_title()
			: mode === 'enter'
				? m.settings_sync_join_title()
				: m.settings_sync_password_change_title()
	);
	/** 同じパスワードをどのデバイスでも入れることを、決める側と入れる側の両方で伝える。変えるときは分かっているので出さない */
	const description = $derived(
		mode === 'create'
			? m.settings_sync_start_description()
			: mode === 'enter'
				? m.settings_sync_join_description()
				: undefined
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
			if (mode === 'create') await invoke('start_sync', { password });
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
		<PasswordInput
			id="{id}-{field}"
			class="max-w-72"
			{autocomplete}
			aria-invalid={errors[field] ? true : undefined}
			aria-describedby={[hint && `${id}-${field}-hint`, errors[field] && `${id}-${field}-error`]
				.filter(Boolean)
				.join(' ') || undefined}
			bind:value={values[field]}
		/>
		{#if hint}
			<Field.Description id="{id}-{field}-hint">{hint}</Field.Description>
		{/if}
		{#if errors[field]}
			<!-- 出たときは部品の role="alert" で読み上げ、欄に戻ったときも読めるよう欄と結ぶ -->
			<Field.Error id="{id}-{field}-error">{errors[field]}</Field.Error>
		{/if}
	</Field.Field>
{/snippet}

<form class="flex flex-col gap-3" aria-label={title} onsubmit={submit}>
	<Field.Title>{title}</Field.Title>
	{#if description}
		<Field.Description class="leading-snug">{description}</Field.Description>
	{/if}
	{#if mode === 'create'}
		{@render passwordField(
			'password',
			m.settings_sync_password(),
			'new-password',
			m.settings_sync_password_hint({ count: MIN_SYNC_PASSWORD_CHARS })
		)}
		{@render passwordField('confirm', m.settings_sync_password_confirm(), 'new-password')}
	{:else if mode === 'enter'}
		{@render passwordField('password', m.settings_sync_password(), 'current-password')}
	{:else}
		{@render passwordField('current', m.settings_sync_password_current(), 'current-password')}
		{@render passwordField('password', m.settings_sync_password_new(), 'new-password')}
		{@render passwordField('confirm', m.settings_sync_password_new_confirm(), 'new-password')}
	{/if}
	<div class="flex flex-wrap items-center gap-2">
		<Button type="submit" class="w-fit" disabled={busy || !filled}>
			{mode === 'change'
				? m.settings_sync_password_save()
				: mode === 'enter'
					? m.settings_sync_join()
					: m.settings_sync_start()}
		</Button>
		{#if oncancel}
			<Button type="button" variant="ghost" disabled={busy} onclick={oncancel}>
				{m.common_cancel()}
			</Button>
		{/if}
	</div>
</form>
