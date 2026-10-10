<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { clamp } from '$lib/clamp';
	import PaletteFrame from '$lib/components/palette-frame.svelte';
	import { Button } from '$lib/components/ui/button';
	import { deviceLabels } from '$lib/devices';
	import { errorCode } from '$lib/errors';
	import { isImeKey, toDraftKey, type Platform } from '$lib/keys';
	import { m } from '$lib/paraglide/messages';
	import type { Device } from '$lib/settings.svelte';

	type Props = {
		devices: Device[];
		platform: Platform;
		/** 一覧を開くキー。開いている間に押すと閉じる。空文字は割り当てなし */
		targetsKey: string;
		/** チェックが入っていて、つながった機器の公開鍵を受け取り、その機器へ送る */
		onsend: (publicKeys: string[]) => void;
		/** 送らずに閉じる */
		onclose: () => void;
		/** チェックを設定に覚えられなかった。原因を受け取る */
		onerror: (message: string) => void;
	};

	let { devices, platform, targetsKey, onsend, onclose, onerror }: Props = $props();

	const id = $props.id();
	let active = $state(0);
	// 生存確認でつながった機器の公開鍵。確かめている間は null
	let reachable = $state<Set<string> | null>(null);
	/** この機器が Pro でないときだけ、送信先を選べない理由を一覧に出す。 */
	let probeError = $state('');
	const labels = $derived(deviceLabels(devices));
	// 開いている間に設定が変わって台数が減っても、一覧の外を選ばないようにする
	const selected = $derived(Math.min(active, devices.length - 1));

	// 開いたときに一度だけ確かめる（docs/lan.md「同じ LAN の自分の機器へ送る」）。
	// 周期的には確かめない。使っていない間も通信し続けるのを避けるため
	onMount(() => {
		let closed = false;
		invoke<string[]>('probe_devices')
			.then((keys) => {
				if (!closed) reachable = new Set(keys);
			})
			.catch((error) => {
				// 確かめられなければ、どれもつながらないとみなす。詳しくは Rust 側でログに残す
				if (!closed) {
					reachable = new Set();
					if (errorCode(error) === 'lan.pro_required') probeError = m.lan_error_pro_required();
				}
			});
		return () => {
			closed = true;
		};
	});

	// この一覧で押したチェック（公開鍵ごと）。設定の反映（settings-changed）を待たずに続けて押しても、
	// 前に押した分を古い設定で上書きしないよう、押した状態をここで先に持つ
	const pressed = new SvelteMap<string, boolean>();
	const sendTo = (device: Device) => pressed.get(device.publicKey) ?? device.sendTo;
	// 保存は押した順に1つずつ行う。同時に投げると、後に押した分が先に書き終わり、前に押した古い状態で上書きされうる
	let saving: Promise<unknown> = Promise.resolve();
	// この一覧で最後に保存できた送信先の公開鍵。設定の反映（settings-changed）より先に分かる
	let saved: Set<string> | null = null;
	const canCheck = (device: Device) => reachable?.has(device.publicKey) ?? false;
	// つながらない機器は、チェックを覚えていても送らないので、外れて見せる
	const isChecked = (device: Device) => sendTo(device) && canCheck(device);

	/** チェックを入れ外しして、設定に覚える。つながらない機器や、確かめている間は変えない */
	function toggle(device: Device) {
		if (!canCheck(device)) return;
		const next = !sendTo(device);
		pressed.set(device.publicKey, next);
		// 前の保存の失敗は、その回で知らせ終えているので、ここでは捨てて続ける。
		// 送る一覧は投げる直前に組み立てる。前の保存が失敗して戻したチェックを、ここで書き戻さないため
		saving = saving
			.catch(() => {})
			.then(async () => {
				const publicKeys = devices.filter((other) => sendTo(other)).map((other) => other.publicKey);
				await invoke('set_send_targets', { publicKeys });
				saved = new Set(publicKeys);
			});
		saving.catch((error) => {
			// 覚えられなければ、保存できている状態に戻す。その後にまた押していたら、そちらを残す。
			// この一覧でまだ保存できていなければ、設定の値が保存できている状態
			if (pressed.get(device.publicKey) === next) {
				if (saved) pressed.set(device.publicKey, saved.has(device.publicKey));
				else pressed.delete(device.publicKey);
			}
			onerror(errorCode(error));
		});
	}

	function send() {
		const keys = devices.filter(isChecked).map((device) => device.publicKey);
		if (keys.length > 0) onsend(keys);
	}

	function onKeydown(event: KeyboardEvent) {
		// IME が処理したキーは、変換の操作なので横取りしない
		if (isImeKey(event)) return;
		// 一覧を開くキーは Tab を含むこともあるので、Tab より先に見る
		if (targetsKey && toDraftKey(event, platform) === targetsKey) {
			event.preventDefault();
			onclose();
			return;
		}
		// フォーカスは一覧だけに置くので、Tab で後ろの下書きへ抜けないようにする
		if (event.key === 'Tab') {
			event.preventDefault();
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onclose();
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			active = clamp(selected + step, 0, devices.length - 1);
		} else if (event.key === ' ') {
			event.preventDefault();
			const device = devices[selected];
			if (device) toggle(device);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			send();
		}
	}
</script>

<!--
	下は、下書きの下の列（h-7 のボタンと窓の余白 p-2 で 2.25rem）に重ならないよう、0.5rem の間を足して 2.75rem 空ける
-->
<PaletteFrame
	label={m.draft_send_targets_list()}
	maxHeightClass="max-h-[calc(100%-4.5rem)]"
	{onclose}
>
	<div class="flex h-9 shrink-0 items-center border-b px-3 text-sm font-medium">
		{m.draft_send_targets_list()}
		{#if reachable === null}
			<span role="status" class="ml-auto text-xs font-normal text-muted-foreground">
				{m.draft_send_targets_checking()}
			</span>
		{/if}
	</div>
	<!-- キーボードでは一覧にフォーカスを置き、↑↓ で移り、Space でチェック、Enter で送る -->
	<ul
		id="{id}-list"
		role="listbox"
		aria-label={m.draft_send_targets_list()}
		aria-multiselectable="true"
		aria-activedescendant={devices.length > 0 ? `${id}-option-${selected}` : undefined}
		tabindex="-1"
		class="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-1 outline-none"
		onkeydown={onKeydown}
		{@attach (element) => element.focus()}
	>
		{#each devices as device, index (device.publicKey)}
			{@const usable = canCheck(device)}
			<!-- キーボードでは一覧の ↑↓ と Space で選ぶので、項目自体はフォーカスを取らない -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<li
				id="{id}-option-{index}"
				role="option"
				aria-selected={isChecked(device)}
				aria-disabled={!usable}
				data-active={index === selected}
				class="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 aria-disabled:text-muted-foreground data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
				onpointerdown={(event) => event.preventDefault()}
				onpointermove={() => (active = index)}
				onclick={() => toggle(device)}
				{@attach (element) => {
					if (index === selected) element.scrollIntoView({ block: 'nearest' });
				}}
			>
				<span
					class="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input data-[checked=true]:border-primary data-[checked=true]:bg-primary data-[checked=true]:text-primary-foreground"
					data-checked={isChecked(device)}
					aria-hidden="true"
				>
					{#if isChecked(device)}<CheckIcon class="size-3.5" />{/if}
				</span>
				<span class="min-w-0 flex-1 truncate text-sm">{labels.get(device.publicKey)}</span>
				{#if reachable !== null && !usable}
					<span class="shrink-0 text-xs">{m.draft_send_targets_unreachable()}</span>
				{/if}
			</li>
		{/each}
	</ul>
	{#if probeError}
		<p class="shrink-0 border-t px-3 py-1.5 text-xs text-muted-foreground">{probeError}</p>
	{/if}
	<div class="flex shrink-0 items-center gap-2 border-t px-3 py-1.5">
		<span class="text-xs text-muted-foreground">{m.draft_send_targets_keys()}</span>
		<Button
			tabindex={-1}
			size="sm"
			class="ml-auto"
			disabled={!devices.some(isChecked)}
			onpointerdown={(event: PointerEvent) => event.preventDefault()}
			onclick={send}
		>
			{m.draft_send()}
		</Button>
	</div>
</PaletteFrame>
