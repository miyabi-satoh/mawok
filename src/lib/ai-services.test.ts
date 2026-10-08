import { describe, expect, it } from 'vitest';
import type { AiService } from '$lib/settings.svelte';
import { modelFor } from './ai-services';

describe('modelFor', () => {
	it('AI サービスを替えたら、替えた先で設定したモデルを出す', () => {
		// サービスが1つの今は画面から替えられないので、2つ目のサービスを仮に置いて確かめる
		const models = { gemini: 'gemini-3.8-flash', other: 'other-model' } as Partial<
			Record<AiService, string>
		>;

		expect(modelFor(models, 'gemini')).toBe('gemini-3.8-flash');
		expect(modelFor(models, 'other' as AiService)).toBe('other-model');
	});

	it('設定していないサービスは空（既定のモデル）にする', () => {
		expect(modelFor({ gemini: 'gemini-3.8-flash' }, 'other' as AiService)).toBe('');
	});
});
