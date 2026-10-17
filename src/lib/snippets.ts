import { CONSTANTS } from '$lib/bindings/constants';
import { matchesFilter } from '$lib/list-filter';
import type { Snippet } from '$lib/settings.svelte';

/** 新しく足す定型文の1件。結果の出し方・文字コード・有効かは、Rust 側の既定と同じにする */
export function newSnippet(name: string, body: string): Snippet {
	return { ...CONSTANTS.NEW_SNIPPET, name, body };
}

/** 一覧で選ぶ、名前と本文の組 */
export type NamedText = {
	name: string;
	body: string;
};

/** 本文の最初の空でない行。なければ空文字 */
export function firstLine(body: string): string {
	return body.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
}

/** 一覧に出す見出し。名前が空なら、本文の最初の空でない行を代わりに出す */
export function snippetLabel(snippet: NamedText): string {
	return snippet.name.trim() !== '' ? snippet.name : firstLine(snippet.body);
}

/** 見出しの下に添える本文の1行目。名前がなく本文の行を見出しにしたときは、同じ行を重ねて出さない */
export function snippetPreview(snippet: NamedText): string {
	return snippet.name.trim() !== '' ? firstLine(snippet.body) : '';
}

/**
 * 一覧に出す定型文。本文が空のものは差し込むものがないので除く。
 * 打った文字列が名前か本文に含まれるものだけを、登録した順のまま残す（matchesFilter）
 */
export function filterSnippets<T extends NamedText>(snippets: T[], query: string): T[] {
	return snippets.filter(
		(snippet) => snippet.body !== '' && matchesFilter(query, snippet.name, snippet.body)
	);
}
