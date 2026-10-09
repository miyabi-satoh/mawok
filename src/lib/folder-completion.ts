import type { FolderCompletion } from '$lib/bindings/FolderCompletion';

/**
 * 打っている途中に薄く出す続き（fish の autosuggestion。docs/actions.md「作業フォルダー」）。
 * 当てはまるフォルダーが1つで、打った所の先へ補えるときだけ、補った後の欄のうち打った所より先を返す
 */
export function suggestionSuffix(input: string, completion: FolderCompletion): string {
	if (completion.candidates.length > 0) return '';
	const suggested = completion.input;
	// 大文字と小文字は区別せずに拾うので、打った所は書き方が違っても続きとみなす
	if (suggested.length <= input.length) return '';
	if (suggested.slice(0, input.length).toLowerCase() !== input.toLowerCase()) return '';
	return suggested.slice(input.length);
}

/** 候補を選ぶ位置を、step だけ動かす。端の先は反対の端へ回る。まだ選んでいない（-1）ときは、進むなら先頭、戻るなら末尾から */
export function stepSelection(selected: number, count: number, step: 1 | -1): number {
	if (count === 0) return -1;
	if (selected < 0) return step === 1 ? 0 : count - 1;
	return (selected + step + count) % count;
}
