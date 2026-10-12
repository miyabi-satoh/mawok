<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import SettingsRow from '$lib/components/settings-row.svelte';
	import SettingsSection from '$lib/components/settings-section.svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import { EVENTS } from '$lib/bindings/constants';
	import type { PairingOffer } from '$lib/bindings/PairingOffer';
	import type { Call } from '$lib/call';
	import { deviceLabels } from '$lib/devices';
	import { devicesPanel } from '$lib/devices-panel';
	import { onEvent } from '$lib/on-event';
	import { pairingOfferDescription, pairingOfferRemainingSeconds } from '$lib/pairing-offer';
	import { m } from '$lib/paraglide/messages';
	import type { SettingsView } from '$lib/settings.svelte';

	/**
	 * 設定画面の「デバイス」の分類。
	 * 設定画面は、この分類を開いていない間も描いたままにする。分類を移っても、出しているコードと打ちかけのコードを残すため。
	 * open は、この分類を開いているか。lanCall は、ペアリングの失敗を何をすればよいかの案内にして出す Call
	 */
	let {
		view,
		open,
		call,
		lanCall,
		onopenaccount
	}: {
		view: SettingsView;
		open: boolean;
		call: Call;
		lanCall: Call;
		onopenaccount: () => void;
	} = $props();

	const panel = $derived(devicesPanel(view.proAvailable, view.accountKeyStatus));

	/** 出しているコード。空なら出していない（docs/lan.md「同じ LAN の自分のデバイスへ送る」） */
	let pairingCode = $state('');
	/** `want` を受けて自動で出したコードか。相手のデバイスに出す案内だけを替える。 */
	let pairingAutomatic = $state(false);
	/** 違う確認コードを試した後に出したコードか。次のコードに替わるまで案内する。 */
	let pairingPreviousCodeWasWrong = $state(false);
	let pairingDescription = $derived(
		pairingOfferDescription(pairingAutomatic, pairingPreviousCodeWasWrong)
	);
	/** 相手に出ているコードを入れる欄 */
	let joinCode = $state('');
	/** コードを入れて、相手を探している最中か */
	let joining = $state(false);

	/** 出したコードが使えなくなるまでの残り秒。Rust 側から受け取った残り秒を、画面の単調な時計で減らす */
	let pairingRemainingSeconds = $state(0);
	/** コードが使えなくなる時刻（performance.now() の値）。OS の時計の変更に影響されない */
	let pairingDeadline = 0;
	$effect(() => {
		if (!pairingCode) return;
		const timer = setInterval(() => {
			pairingRemainingSeconds = pairingOfferRemainingSeconds(pairingDeadline, performance.now());
		}, 250);
		return () => clearInterval(timer);
	});

	$effect(() => onEvent(EVENTS.PAIRING_CODE_ENDED, clearPairingOffer));
	$effect(() => onEvent<PairingOffer>(EVENTS.PAIRING_CODE_OFFERED, showPairingOffer));

	async function startPairing() {
		const offer = await lanCall<PairingOffer>('start_pairing');
		if (!offer.ok) return;
		showPairingOffer(offer.value);
	}

	function showPairingOffer(offer: PairingOffer) {
		pairingRemainingSeconds = offer.remainingSeconds;
		pairingDeadline = performance.now() + offer.remainingSeconds * 1000;
		pairingCode = offer.code;
		pairingAutomatic = offer.automatic;
		pairingPreviousCodeWasWrong = offer.previousCodeWasWrong;
	}

	/** コードを出していない状態に戻す */
	function clearPairingOffer() {
		pairingCode = '';
		pairingAutomatic = false;
		pairingPreviousCodeWasWrong = false;
	}

	function cancelPairing() {
		clearPairingOffer();
		pairingRemainingSeconds = 0;
		void call('cancel_pairing');
	}

	async function joinPairing() {
		joining = true;
		if ((await lanCall('join_pairing', { code: joinCode })).ok) joinCode = '';
		joining = false;
	}

	/** 設定を開いた後に `want` を受けて自動で出したコードも、設定画面に表示する。 */
	$effect(() => {
		if (!open || view.accountKeyStatus !== 'ready') return;
		let active = true;
		void (async () => {
			const offer = await invoke<PairingOffer | null>('pairing_offer').catch(() => null);
			if (active && offer) showPairingOffer(offer);
		})();
		return () => {
			active = false;
		};
	});

	let resetKeyOpen = $state(false);
	/** 確かめを「このデバイスから始め直す」の言い方で出すか。開いたときに決め、実行して鍵の状態が変わっても、閉じるまで文を替えない */
	let resetKeyRestarts = $state(false);
	let resettingKey = $state(false);
	function openResetKey(restarts: boolean) {
		resetKeyRestarts = restarts;
		resetKeyOpen = true;
	}
	async function resetAccountKey() {
		resettingKey = true;
		if ((await lanCall('reset_account_key')).ok) resetKeyOpen = false;
		resettingKey = false;
	}

	function setDeviceSendTo(publicKey: string, sendTo: boolean) {
		const publicKeys = view.devices
			.filter((device) => (device.publicKey === publicKey ? sendTo : device.sendTo))
			.map((device) => device.publicKey);
		void call('set_send_targets', { publicKeys });
	}

	$effect(() => {
		void invoke('set_devices_open', { open });
		return () => void invoke('set_devices_open', { open: false });
	});
</script>

<!-- 鍵を作り直す操作。鍵を待つ状態では、ほかのデバイスを使えない人向けの出口として案内する。 -->
{#snippet resetKeyRow(restarts: boolean, title: string, start: string, description?: string)}
	<SettingsRow>
		<Field.Field orientation="horizontal" class="min-h-8">
			<Field.Title>{title}</Field.Title>
			<Button variant="destructive" onclick={() => openResetKey(restarts)}>
				{start}
			</Button>
		</Field.Field>
		{#if description}
			<Field.Description class="leading-snug">{description}</Field.Description>
		{/if}
	</SettingsRow>
{/snippet}

<SettingsSection>
	{#if panel === 'pro'}
		<SettingsRow>
			<Field.Description class="leading-snug">
				{view.mawokAccountSignedIn
					? m.settings_devices_pro_description()
					: m.settings_devices_pro_sign_in()}
			</Field.Description>
			{#if view.mawokAccountSignedIn}
				<Button
					variant="outline"
					size="sm"
					class="w-fit"
					onclick={() => call('open_mawok_pro_page')}
				>
					{m.settings_mawok_pro_pricing()}
				</Button>
			{:else}
				<Button variant="outline" size="sm" class="w-fit" onclick={onopenaccount}>
					{m.settings_account_open()}
				</Button>
			{/if}
		</SettingsRow>
	{:else if panel === 'none'}
		<SettingsRow>
			<Field.Description class="leading-snug">{m.settings_devices_not_ready()}</Field.Description>
		</SettingsRow>
	{:else if panel === 'needsPairing'}
		<!-- 鍵を持つ状態の「デバイスを追加」と同じく、題名を左、操作を右、説明を下に置く -->
		<SettingsRow>
			<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
				<Field.Title>{m.settings_devices_join_title()}</Field.Title>
				<div class="flex gap-2">
					<Input
						class="w-32 font-mono text-sm"
						inputmode="numeric"
						autocomplete="off"
						maxlength={6}
						aria-label={m.settings_devices_join()}
						bind:value={joinCode}
					/>
					<Button
						variant="outline"
						disabled={joining || joinCode.length !== 6}
						onclick={joinPairing}
					>
						{joining ? m.settings_devices_joining() : m.settings_devices_join_submit()}
					</Button>
				</div>
			</Field.Field>
			<Field.Description class="leading-snug">
				{m.settings_devices_needs_pairing()}
			</Field.Description>
		</SettingsRow>
		{@render resetKeyRow(
			true,
			m.settings_devices_restart(),
			m.settings_devices_restart_start(),
			m.settings_devices_restart_description()
		)}
	{:else if panel === 'ready'}
		<SettingsRow>
			<Field.Title>{m.settings_devices_list_title()}</Field.Title>
			{#if view.devices.length > 0}
				{@const labels = deviceLabels(view.devices)}
				<!-- 同じ名前のデバイスは、送信先の一覧と同じく公開鍵の先頭4文字で見分ける。 -->
				<div class="flex flex-col gap-3">
					{#each view.devices as device (device.publicKey)}
						<Field.Field orientation="horizontal">
							<Field.Label for={`send-to-${device.publicKey}`}>
								{labels.get(device.publicKey) ?? device.name}
							</Field.Label>
							<Switch
								id={`send-to-${device.publicKey}`}
								bind:checked={
									() => device.sendTo, (sendTo) => setDeviceSendTo(device.publicKey, sendTo)
								}
							/>
						</Field.Field>
					{/each}
				</div>
			{:else}
				<Field.Description class="leading-snug">{m.settings_devices_empty()}</Field.Description>
			{/if}
		</SettingsRow>
		<SettingsRow>
			<Field.Field orientation="horizontal" class="min-h-8">
				<Field.Title>{m.settings_devices_offer()}</Field.Title>
				{#if pairingCode}
					<div class="flex items-center gap-2">
						<span class="font-mono text-2xl tracking-widest tabular-nums">{pairingCode}</span>
						{#if !pairingAutomatic}
							<Button variant="ghost" onclick={cancelPairing}>{m.common_cancel()}</Button>
						{/if}
					</div>
				{:else}
					<Button variant="outline" onclick={startPairing}
						>{m.settings_devices_offer_start()}</Button
					>
				{/if}
			</Field.Field>
			<Field.Description
				class="leading-snug"
				role={pairingCode ? 'timer' : undefined}
				aria-live="off"
			>
				{pairingCode
					? pairingDescription === 'wrongCode'
						? m.settings_devices_offer_wrong_code({ seconds: pairingRemainingSeconds })
						: pairingDescription === 'automatic'
							? m.settings_devices_offer_automatic({ seconds: pairingRemainingSeconds })
							: m.settings_devices_offer_waiting({ seconds: pairingRemainingSeconds })
					: m.settings_devices_offer_description()}
			</Field.Description>
		</SettingsRow>
		{@render resetKeyRow(
			false,
			m.settings_devices_reset_key(),
			m.settings_devices_reset_key_start()
		)}
	{/if}
</SettingsSection>

<AlertDialog.Root bind:open={resetKeyOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>
				{resetKeyRestarts
					? m.settings_devices_restart_confirm_title()
					: m.settings_devices_reset_key_confirm_title()}
			</AlertDialog.Title>
			<AlertDialog.Description
				>{resetKeyRestarts
					? m.settings_devices_restart_confirm_description()
					: m.settings_devices_reset_key_confirm_description()}</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={resettingKey}>{m.common_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action disabled={resettingKey} onclick={resetAccountKey}>
				{resetKeyRestarts
					? m.settings_devices_restart_confirm_start()
					: m.settings_devices_reset_key_start()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
