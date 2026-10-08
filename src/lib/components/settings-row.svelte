<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children?: Snippet } = $props();
</script>

<div class="flex flex-col gap-2 px-4 py-3 leading-snug" data-settings-row>
	{@render children?.()}
</div>
