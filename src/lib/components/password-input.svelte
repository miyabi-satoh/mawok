<script lang="ts">
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import * as InputGroup from '$lib/components/ui/input-group';
	import { m } from '$lib/paraglide/messages';
	import type { ComponentProps } from 'svelte';

	/** 打った文字を見て確かめられるよう、見せる・隠すを切り替えられるパスワードの欄 */
	type Props = Omit<ComponentProps<typeof InputGroup.Input>, 'type' | 'files'> & {
		class?: string;
	};

	let { value = $bindable(''), class: className, ...restProps }: Props = $props();

	let visible = $state(false);
</script>

<InputGroup.Root class={className}>
	<!-- 見せている間も、綴りの下線・自動の大文字・置き換えでパスワードが書き換わらないようにする -->
	<InputGroup.Input
		bind:value
		type={visible ? 'text' : 'password'}
		spellcheck={false}
		autocapitalize="off"
		autocorrect="off"
		{...restProps}
	/>
	<InputGroup.Addon align="inline-end">
		<InputGroup.Button
			size="icon-xs"
			aria-label={m.password_input_show()}
			aria-pressed={visible}
			onclick={() => (visible = !visible)}
		>
			{#if visible}
				<EyeOffIcon />
			{:else}
				<EyeIcon />
			{/if}
		</InputGroup.Button>
	</InputGroup.Addon>
</InputGroup.Root>
