<script lang="ts">
	import { m } from '$lib/paraglide/messages';

	let { class: className = 'inset-y-2 left-0' }: { class?: string } = $props();
</script>

<span class={`absolute w-0.5 bg-primary ${className}`} aria-hidden="true"></span>
<span class="sr-only">{m.settings_modified()}</span>
