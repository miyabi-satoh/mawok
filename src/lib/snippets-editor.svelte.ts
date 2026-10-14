import { SvelteSet } from 'svelte/reactivity';
import { okValue, type Call } from '$lib/call';
import { modelFor } from '$lib/ai-services';
import { isBlankSnippet } from '$lib/blank-rows';
import { RowList } from '$lib/row-list.svelte';
import { coalescedSaver } from '$lib/saver';
import type { AiService, SettingsView, Snippet } from '$lib/settings.svelte';
import { newSnippet } from '$lib/snippets';

/**
 * 設定画面の「定型文」で編集している定型文とモデル。
 * 定型文の分類は開いている間だけ描くので、置き換え辞書と同じく設定画面の本体がこれを持ち、
 * 分類を移って戻っても打った内容と保存のしくみを保つ（戻ったときに古い写しで作り直すと、直前の入力を保存で消しかねない）。
 * 打っている途中に Rust 側からの反映で打ち消されないよう、最初の1回だけ写して以降は画面側が持ち主になる
 */
export class SnippetsEditor {
	readonly snippets: RowList<Snippet>;
	/** 開いている行の画面用 key と、絞り込みの語。分類を移っても保つ */
	readonly expanded = new SvelteSet<string>();
	filter = $state('');
	model = $state('');
	/** 欄のモデルがどの AI サービスのものか。替えた直後に、前のサービスのモデルとして保存しないため */
	modelService = $state<AiService>('none');

	readonly call: Call;
	/** 定型文を写したときの表示言語 */
	#snippetsLocale: string | undefined;

	constructor(view: SettingsView | null, call: Call) {
		this.call = call;
		this.#snippetsLocale = view?.locale;
		this.snippets = new RowList(
			view?.snippets ?? [],
			async (snippets) => okValue(await this.call<Snippet[]>('set_snippets', { snippets })),
			isBlankSnippet
		);
		if (view) {
			this.model = modelFor(view.aiModels, view.aiService);
			this.modelService = view.aiService;
		}
	}

	/**
	 * 表示言語が替わったら、定型文を写し直す。既定の定型文（設定ファイルに書いていない）は言語ごとに違うので、
	 * 写し直さないと前の言語の定型文を出し続け、1行直すと前の言語のまま保存してしまう。画面で変えていたら写し直さない
	 */
	followLocale(view: SettingsView) {
		if (view.locale === this.#snippetsLocale) return;
		this.#snippetsLocale = view.locale;
		this.snippets.recopy(view.snippets);
	}

	/** 同期が設定を変えたら、定型文とモデルを写し直す。画面で変えていても写す（RowList.recopy の force） */
	recopy(view: SettingsView) {
		this.#snippetsLocale = view.locale;
		this.snippets.recopy(view.snippets, true);
		this.switchService(view.aiModels, view.aiService);
	}

	saveModel = coalescedSaver(() =>
		this.call('set_ai_model', { service: this.modelService, model: this.model })
	);

	setModel(model: string) {
		this.model = model;
		this.saveModel();
	}

	/** AI サービスを替えたら、モデルの欄を替えた先で設定したものにする */
	switchService(models: Partial<Record<AiService, string>>, service: AiService) {
		this.model = modelFor(models, service);
		this.modelService = service;
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

	async addDefaultSnippets() {
		const defaults = await this.call<Snippet[]>('default_snippets');
		if (!defaults.ok) return;
		// 足した行が絞り込みで隠れないよう、絞り込みを解く
		this.filter = '';
		this.snippets.add(...defaults.value);
	}
}
