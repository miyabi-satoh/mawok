<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import SettingsRow from '$lib/components/settings-row.svelte';
	import SettingsSection from '$lib/components/settings-section.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import type { SignedInDevice } from '$lib/bindings/SignedInDevice';
	import type { Call } from '$lib/call';
	import { m } from '$lib/paraglide/messages';

	/**
	 * 同じアカウントにサインインしているデバイス（docs/account-server.md「Mawok とアカウントを結ぶ」）。
	 * ほかのデバイスはここからサインアウトさせる。このデバイスのサインアウトは、アカウントの行に置いてある
	 */
	let { call }: { call: Call } = $props();

	/** 窓口が答えた一覧。読めていなければ null で、見出しごと出さない */
	let devices = $state<SignedInDevice[] | null>(null);

	// 一覧は補いの情報なので、読めなくても画面のエラーにはしない（窓口につながらないことは、使う操作のときに出す）
	async function load() {
		devices = await invoke<SignedInDevice[]>('mawok_devices').catch(() => null);
	}

	$effect(() => {
		void load();
	});

	async function signOut(id: string) {
		if ((await call('sign_out_mawok_device', { id })).ok) await load();
	}
</script>

{#if devices && devices.length > 0}
	<SettingsSection title={m.settings_devices_title()}>
		{#each devices as device (device.id)}
			<SettingsRow>
				<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
					<Field.Title>{device.name}</Field.Title>
					{#if device.current}
						<span class="text-sm text-muted-foreground">{m.settings_devices_this_device()}</span>
					{:else}
						<Button variant="outline" size="sm" onclick={() => signOut(device.id)}>
							{m.settings_mawok_sign_out()}
						</Button>
					{/if}
				</Field.Field>
			</SettingsRow>
		{/each}
	</SettingsSection>
{/if}
