<script lang="ts">
	import { m } from '$lib/paraglide/messages';

	let { class: className = 'inset-y-2 left-0' }: { class?: string } = $props();
</script>

<span class={`absolute w-2 ${className}`} title={m.settings_modified()} aria-hidden="true">
	<span class="absolute inset-y-0 left-0 w-0.5 bg-primary"></span>
</span>
<span class="sr-only">{m.settings_modified()}</span>
