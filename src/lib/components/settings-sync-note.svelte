<script lang="ts">
	/** 同期の印の説明と、種類ごとの同期を切っている知らせ。置く場所で余白が違うので、余白は class で受け取る */
	let { text, class: className }: { text: string; class?: string } = $props();
</script>

<p class={[className, 'text-xs leading-snug text-muted-foreground']}>{text}</p>
