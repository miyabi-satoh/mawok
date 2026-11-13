import { matchesFilter } from '#lib/list-filter.ts';
import { firstLine } from '#lib/snippets.ts';

/** 検索の一覧の1件。名前の無い定型文と同じ形にして、定型文の一覧と同じ部品で出す（index は DraftHistory.jump に渡す位置） */
export type HistoryItem = { name: ''; body: string; index: number };

/** 検索の一覧に出す履歴。entries は古い順。新しいものから並べ、同じ本文は新しい方だけを残す */
export function historyItems(entries: readonly string[]): HistoryItem[] {
	const seen = new Set<string>();
	const items: HistoryItem[] = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const body = entries[index];
		if (seen.has(body)) continue;
		seen.add(body);
		items.push({ name: '', body, index });
	}
	return items;
}

/**
 * 検索の一覧で見出し（最初の空でない行）の下に添える行。絞り込みの語が見出しに無く、2行目より後に当たったときだけ、
 * 当たった最初の行を出す。見出しだけでは、なぜ当たったのかが分からないため
 */
export function historyPreview(body: string, query: string): string {
	if (query.trim() === '') return '';
	const label = firstLine(body);
	if (matchesFilter(query, label)) return '';
	return (
		body
			.split(/\r?\n/)
			.find((line) => line !== label && matchesFilter(query, line))
			?.trim() ?? ''
	);
}
