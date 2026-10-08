<script lang="ts">
	import SearchIcon from '@lucide/svelte/icons/search';
	import { Input } from '$lib/components/ui/input';

	/** 設定の一覧を絞り込む欄。欄の意味は虫眼鏡と aria-label で示し、placeholder は置かない */
	let { value = $bindable(''), label }: { value?: string; label: string } = $props();
</script>

<div class="relative">
	<SearchIcon
		class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
		aria-hidden="true"
	/>
	<Input type="search" class="pl-8 text-sm" aria-label={label} autocomplete="off" bind:value />
</div>
