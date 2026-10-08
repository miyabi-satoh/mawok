import { untrack } from 'svelte';

/** 設定の一覧（置き換え辞書・定型文・アクション）に絞り込みの欄を出す件数。少ないうちは見渡せるので出さない */
const FILTER_MIN_ROWS = 6;

/** 絞り込みの欄を出すか。語が残っている間は、件数が減っても出し続ける（消すと絞り込みを解けなくなるため） */
export function showsFilter(count: number, query: string): boolean {
	return count >= FILTER_MIN_ROWS || query !== '';
}

/** 英字の大文字と小文字だけを揃える。toLowerCase は全角英字やほかの文字も変えるので使わない */
function foldAscii(text: string): string {
	return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * 絞り込みの語を、どれかの文字列がそのまま含むか（部分一致）。英字の大文字と小文字は区別しない。
 * 語の前後の空白は除き、空の語なら絞り込まない。
 * 文字が飛び飛びでも当たるあいまい一致は、日本語だと関係ない候補が残りやすいので採らない
 */
export function matchesFilter(query: string, ...texts: string[]): boolean {
	const needle = foldAscii(query.trim());
	return needle === '' || texts.some((text) => foldAscii(text).includes(needle));
}

/**
 * 設定の一覧で、絞り込みに当たった行の id。語が空（空白だけ）なら null（絞り込まない）。
 * 行は追わずに読むので、$derived の中で呼ぶと語を変えたときにだけ求め直す。
 * 行を書き換えるたびに求め直すと、当たらなくなった行が打っている途中で消えてしまうため
 */
export function matchedIds<T extends { id: string }>(
	rows: () => T[],
	query: string,
	texts: (row: T) => string[]
): Set<string> | null {
	if (query.trim() === '') return null;
	return untrack(
		() =>
			new Set(
				rows()
					.filter((row) => matchesFilter(query, ...texts(row)))
					.map((row) => row.id)
			)
	);
}

/** 当たった行だけを、並びのまま返す。ids が null（絞り込んでいない）ならすべて */
export function shownRows<T extends { id: string }>(rows: T[], ids: Set<string> | null): T[] {
	return ids ? rows.filter((row) => ids.has(row.id)) : rows;
}
