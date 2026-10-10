<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import { listen } from '@tauri-apps/api/event';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import { EVENTS } from '$lib/bindings/constants';
	import type { AccountStatus } from '$lib/bindings/AccountStatus';
	import type { MawokSignIn } from '$lib/bindings/MawokSignIn';
	import type { MawokSignInEnded } from '$lib/bindings/MawokSignInEnded';
	import type { Call } from '$lib/call';
	import { m } from '$lib/paraglide/messages';

	/**
	 * AI サービスの「Mawok」のアカウント（docs/account-server.md「Mawok の側」）。キーの欄の代わりに出す。
	 * signedIn はトークンがあるか（キーの確かめと同じく、まだ確かめていなければ undefined、確かめられなかったときは null）。
	 * サインインやサインアウトで変わったら onchanged で知らせ、呼んだ側に確かめ直してもらう
	 */
	let {
		call,
		signedIn,
		proAvailable,
		onchanged
	}: {
		call: Call;
		signedIn: boolean | null | undefined;
		proAvailable: boolean;
		onchanged: () => void;
	} = $props();

	/** 続いているサインインの申し込み。null ならサインインの途中でない */
	let signingIn = $state<MawokSignIn | null>(null);
	/** 前のサインインがうまくいかなかった */
	let signInFailed = $state(false);
	/** 申し込みを頼んで、答えを待っている。続けて押して申し込みを重ねないよう、その間はボタンを止める */
	let starting = $state(false);
	/** 窓口に問い合わせたアカウントの様子。undefined はまだ答えが無い。null は問い合わせられなかった */
	let status = $state<AccountStatus | null | undefined>(undefined);
	/** 窓口に問い合わせている。問い合わせを重ねないよう、その間の問い合わせ直しは見送る */
	let loading = false;

	// サインインしていると分かったら、残りを問い合わせる。設定の「アクション」を開くたびに問い合わせ直す
	$effect(() => {
		if (signedIn !== true) {
			status = undefined;
			return;
		}
		refreshStatus();
	});

	// 窓口で買い足して戻ってきたときに、開き直さなくても残りが変わるよう、ウィンドウに戻るたびに問い合わせ直す。
	// 答えが来るまでは前の表示を残し、ウィンドウを行き来するたびに行が消えないようにする
	$effect(() => {
		if (signedIn !== true) return;
		const onFocus = () => {
			if (!loading) refreshStatus();
		};
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	});

	async function refreshStatus() {
		loading = true;
		const result = await call<AccountStatus | null>('mawok_account_status');
		loading = false;
		if (!result.ok) {
			status = null;
			return;
		}
		// 窓口でトークンが外されていた。手元のトークンも消えたので、確かめ直してもらう
		if (result.value === null) {
			onchanged();
			return;
		}
		status = result.value;
	}

	// 出している申し込みの終わりだけを受ける。やり直す前の申し込みの終わりで、表示を戻さないように
	$effect(() => {
		const unlisten = listen<MawokSignInEnded>(EVENTS.MAWOK_SIGN_IN_ENDED, (event) => {
			if (event.payload.id !== signingIn?.id) return;
			signingIn = null;
			signInFailed = !event.payload.signedIn;
			onchanged();
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	});

	// 画面を閉じても、申し込みは時間切れまで Rust 側が待ち続ける。開き直したら、サインインの途中であることを出し直す
	$effect(() => {
		call<MawokSignIn | null>('mawok_sign_in_pending').then((result) => {
			if (result.ok && result.value && signingIn === null) signingIn = result.value;
		});
	});

	async function signIn() {
		signInFailed = false;
		starting = true;
		const result = await call<MawokSignIn>('start_mawok_sign_in');
		starting = false;
		if (result.ok) signingIn = result.value;
	}

	function cancelSignIn() {
		signingIn = null;
		call('cancel_mawok_sign_in');
	}

	async function signOut() {
		await call('sign_out_mawok');
		onchanged();
	}
</script>

<Field.Content>
	<!-- 狭いときは、題名を折らずに操作を次の行へ回す -->
	<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
		<Field.Title>{m.settings_mawok_account()}</Field.Title>
		{#if signingIn}
			<div class="flex items-center gap-2">
				<Button variant="ghost" onclick={() => call('reopen_mawok_sign_in_page')}>
					{m.settings_mawok_open_again()}
				</Button>
				<Button variant="ghost" onclick={cancelSignIn}>{m.settings_mawok_sign_in_cancel()}</Button>
			</div>
		{:else if signedIn === true}
			<div class="flex items-center gap-2">
				<span class="flex items-center gap-1.5 text-sm text-muted-foreground">
					<CircleCheckIcon aria-hidden="true" class="size-4" />
					{#if status}
						<span>{status.email}</span>
					{/if}
				</span>
				<Button variant="outline" onclick={signOut}>{m.settings_mawok_sign_out()}</Button>
			</div>
		{:else if signedIn !== undefined}
			<Button variant="outline" disabled={starting} onclick={signIn}>
				{m.settings_mawok_sign_in()}
			</Button>
		{/if}
	</Field.Field>
	{#if signingIn}
		<Field.Description class="leading-snug">{m.settings_mawok_signing_in()}</Field.Description>
	{:else if signInFailed}
		<Field.Description class="leading-snug">{m.settings_mawok_sign_in_expired()}</Field.Description>
	{/if}
</Field.Content>
{#if signedIn === true}
	{#if status?.pro.active || proAvailable}
		<Field.Content>
			<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
				<Field.Title>{m.settings_mawok_pro()}</Field.Title>
			</Field.Field>
		</Field.Content>
	{/if}
	<Field.Content>
		<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
			<Field.Title>
				{status
					? m.settings_mawok_remaining({ percent: status.remainingPercent })
					: status === null
						? m.settings_mawok_status_unknown()
						: ''}
			</Field.Title>
			<Button variant="outline" onclick={() => call('open_mawok_buy_page')}>
				{m.settings_mawok_buy()}
			</Button>
		</Field.Field>
	</Field.Content>
{/if}
