import { SvelteSet } from 'svelte/reactivity';
import { okValue, type Call } from '$lib/call';
import { isBlankSnippet } from '$lib/blank-rows';
import { RowList } from '$lib/row-list.svelte';
import type { SettingsView, Snippet } from '$lib/settings.svelte';
import { newSnippet } from '$lib/snippets';

/**
 * 設定画面の「定型文」で編集している定型文。
 * 定型文の分類は開いている間だけ描くので、置き換え辞書と同じく設定画面の本体がこれを持ち、
 * 分類を移って戻っても打った内容と保存のしくみを保つ（戻ったときに古い写しで作り直すと、直前の入力を保存で消しかねない）。
 * 打っている途中に Rust 側からの反映で打ち消されないよう、最初の1回だけ写して以降は画面側が持ち主になる
 */
export class SnippetsEditor {
	readonly snippets: RowList<Snippet>;
	/** 開いている行の画面用 key と、絞り込みの語。分類を移っても保つ */
	readonly expanded = new SvelteSet<string>();
	filter = $state('');

	readonly call: Call;

	constructor(view: SettingsView | null, call: Call) {
		this.call = call;
		this.snippets = new RowList(
			view?.snippets ?? [],
			async (snippets) => okValue(await this.call<Snippet[]>('set_snippets', { snippets })),
			isBlankSnippet,
			(snippet) => snippet.name
		);
	}

	/** 設定のファイルがほかで変わったか、バックアップから戻したことで設定が替わったら、定型文を写し直す（RowList.recopy） */
	recopy(view: SettingsView) {
		this.snippets.recopy(view.snippets);
	}

	/**
	 * 書くための空の1件を開き、その画面用 key を返す。空の行が残っていればそれを使う。
	 * 名前も本文も空の1件は一覧に出ないだけなので、書きかけのまま保存してよい
	 */
	addSnippet(): string {
		// 足した行が絞り込みで隠れないよう、絞り込みを解く
		this.filter = '';
		const row = this.snippets.addBlank(newSnippet('', ''));
		this.expanded.add(row.key);
		return row.key;
	}
}
