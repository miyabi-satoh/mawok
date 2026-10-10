import { SvelteSet } from 'svelte/reactivity';
import { newAction } from '$lib/action-target';
import type { Call } from '$lib/call';
import { modelFor } from '$lib/ai-services';
import { isBlankAction } from '$lib/blank-rows';
import { RowList } from '$lib/row-list.svelte';
import { coalescedSaver } from '$lib/saver';
import type { Action, AiService, SettingsView } from '$lib/settings.svelte';

/**
 * 設定画面の「アクション」で編集しているアクションとモデル。
 * アクションの分類は開いている間だけ描くので、置き換え辞書や定型文と同じく設定画面の本体がこれを持ち、
 * 分類を移って戻っても打った内容と保存のしくみを保つ（戻ったときに古い写しで作り直すと、直前の入力を保存で消しかねない）。
 * 打っている途中に Rust 側からの反映で打ち消されないよう、最初の1回だけ写して以降は画面側が持ち主になる
 */
export class ActionsEditor {
	readonly actions: RowList<Action>;
	/** 開いている行の画面用 key と、絞り込みの語。分類を移っても保つ */
	readonly expanded = new SvelteSet<string>();
	filter = $state('');
	model = $state('');
	/** 欄のモデルがどの AI サービスのものか。替えた直後に、前のサービスのモデルとして保存しないため */
	modelService = $state<AiService>('none');

	readonly call: Call;
	/** アクションを写したときの表示言語 */
	#actionsLocale: string | undefined;

	constructor(view: SettingsView | null, call: Call) {
		this.call = call;
		this.#actionsLocale = view?.locale;
		this.actions = new RowList(
			view?.actions ?? [],
			async (rows) => {
				const result = await this.call<Action[]>('set_actions', {
					actions: rows.map(({ id, name, command, output, encoding, enabled, sync }) => ({
						id,
						name,
						command,
						output,
						encoding,
						enabled,
						sync
					}))
				});
				return result.ok ? result.value : undefined;
			},
			isBlankAction
		);
		if (view) {
			this.model = modelFor(view.aiModels, view.aiService);
			this.modelService = view.aiService;
		}
	}

	/**
	 * 表示言語が替わったら、アクションを写し直す。既定のアクション（設定ファイルに書いていない）は言語ごとに違うので、
	 * 写し直さないと前の言語のアクションを出し続け、1行直すと前の言語のまま保存してしまう。画面で変えていたら写し直さない
	 */
	followLocale(view: SettingsView) {
		if (view.locale === this.#actionsLocale) return;
		this.#actionsLocale = view.locale;
		this.actions.recopy(view.actions);
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
	 * コマンドが空の1件は一覧に出ないだけなので、書きかけのまま保存してよい
	 */
	addAction(): string {
		// 足した行が絞り込みで隠れないよう、絞り込みを解く
		this.filter = '';
		const row = this.actions.addBlank(newAction('', ''));
		this.expanded.add(row.key);
		return row.key;
	}

	async addDefaultActions() {
		const defaults = await this.call<Action[]>('default_actions');
		if (!defaults.ok) return;
		// 足した行が絞り込みで隠れないよう、絞り込みを解く
		this.filter = '';
		this.actions.add(...defaults.value);
	}
}
