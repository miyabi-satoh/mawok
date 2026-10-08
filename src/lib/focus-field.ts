import { tick } from 'svelte';

/** 描き終えてから、id の要素の中の最初の入力欄にフォーカスを移す（足した行にすぐ書けるように） */
export async function focusFirstField(id: string) {
	await tick();
	document.getElementById(id)?.querySelector<HTMLElement>('input, textarea')?.focus();
}
