import type { Action, Replacement, Snippet } from '$lib/settings.svelte';

// 設定の一覧で、欄がすべて空の行（足したまま書かなかった行）か。こうした行は使うときにも出ないので、溜めない（$lib/row-list.svelte.ts）

export function isBlankSnippet({ name, body }: Pick<Snippet, 'name' | 'body'>): boolean {
	return name.trim() === '' && body.trim() === '';
}

export function isBlankAction({ name, command }: Pick<Action, 'name' | 'command'>): boolean {
	return name.trim() === '' && command.trim() === '';
}

/** 置き換える語は空白だけでも意味を持つので、空文字だけを空とみなす */
export function isBlankReplacement({ from, to }: Pick<Replacement, 'from' | 'to'>): boolean {
	return from === '' && to === '';
}
