import type { Call } from '$lib/call';
import { modelFor } from '$lib/ai-services';
import { coalescedSaver } from '$lib/saver';
import type { AiService, SettingsView } from '$lib/settings.svelte';

/**
 * 設定画面の「AI」で編集しているモデル。AI の分類は開いている間だけ描くので、設定画面の本体がこれを持ち、
 * 分類を移って戻っても打った内容と保存のしくみを保つ
 */
export class AiModelEditor {
	model = $state('');
	/** 欄のモデルがどの AI サービスのものか。替えた直後に、前のサービスのモデルとして保存しないため */
	service = $state<AiService>('none');

	readonly #call: Call;

	constructor(view: SettingsView | null, call: Call) {
		this.#call = call;
		if (view) this.switchService(view.aiModels, view.aiService);
	}

	save = coalescedSaver(() =>
		this.#call('set_ai_model', { service: this.service, model: this.model })
	);

	set(model: string) {
		this.model = model;
		this.save();
	}

	/** AI サービスを替えたら、モデルの欄を替えた先で設定したものにする */
	switchService(models: Partial<Record<AiService, string>>, service: AiService) {
		this.model = modelFor(models, service);
		this.service = service;
	}
}
