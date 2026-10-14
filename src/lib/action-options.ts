import { m } from '$lib/paraglide/messages';
import type { ActionEncoding, ActionOutput } from '$lib/settings.svelte';

/** 結果の出し方の選択肢 */
export const OUTPUTS: { value: ActionOutput; name: () => string }[] = [
	{ value: 'replace', name: m.settings_snippets_output_replace },
	{ value: 'insert', name: m.settings_snippets_output_insert },
	{ value: 'none', name: m.settings_snippets_output_none }
];

/** コマンドの文字コードの選択肢（docs/actions.md「コマンド」）。名前は文字コードの名前なので、表示言語で変えない */
export const ENCODINGS: { value: ActionEncoding; name: string }[] = [
	{ value: 'utf-8', name: 'UTF-8' },
	{ value: 'shift_jis', name: 'Shift_JIS' },
	{ value: 'euc-jp', name: 'EUC-JP' },
	{ value: 'iso-2022-jp', name: 'JIS (ISO-2022-JP)' },
	{ value: 'utf-16le', name: 'UTF-16 LE' }
];
