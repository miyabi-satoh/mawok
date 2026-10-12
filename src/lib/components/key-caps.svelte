<script lang="ts">
	import * as Kbd from '$lib/components/ui/kbd';
	import { keyLabels, type Platform } from '$lib/keys';

	/** 割り当てたキーを、押すキーごとに分けて出す */
	let { key, platform }: { key: string; platform: Platform } = $props();
</script>

<Kbd.Group>
	{#each keyLabels(key, platform) as label (label)}
		<Kbd.Root>{label}</Kbd.Root>
	{/each}
</Kbd.Group>
