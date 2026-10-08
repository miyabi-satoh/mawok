import { matchesFilter } from '$lib/list-filter';

/**
 * 一覧で選ぶ、名前と本文の組。定型文（本文）とアクション（コマンドの行を本文として渡す）で使う。
 * 一覧の出し方と絞り込みは同じにする
 */
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
 * 一覧に出す定型文（やアクション）。本文が空のものは差し込むもの（実行するコマンド）がないので除く。
 * 打った文字列が名前か本文に含まれるものだけを、登録した順のまま残す（matchesFilter）
 */
export function filterSnippets<T extends NamedText>(snippets: T[], query: string): T[] {
	return snippets.filter(
		(snippet) => snippet.body !== '' && matchesFilter(query, snippet.name, snippet.body)
	);
}
