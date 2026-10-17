import { describe, expect, it } from 'vitest';
import type { AiService } from '$lib/settings.svelte';
import { aiServiceInfo, modelFor, normalizeBaseUrl } from './ai-services';

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

describe('normalizeBaseUrl', () => {
	it('Rust と同じ決まりで揃え、受けられないものは null にする', () => {
		const cases: [string, string | null][] = [
			['', ''],
			[' https://api.openai.com/v1/ ', ''],
			['https://API.OpenAI.com/v1', ''],
			['https://api.deepseek.com/', 'https://api.deepseek.com'],
			['http://localhost:11434/v1', 'http://localhost:11434/v1'],
			['ftp://example.com', null],
			['api.deepseek.com', null],
			['https://user:secret@example.com/v1', null],
			['https://example.com/v1?key=1', null],
			['https://example.com/v1#x', null],
			['https://example.com/v1?', null],
			['https://openrouter.ai/api/v1/chat/completions', 'https://openrouter.ai/api/v1'],
			['https://x.com/v1/chat/completions/chat/completions', null],
			['https://API.DeepSeek.com/v1/', 'https://api.deepseek.com/v1']
		];
		for (const [input, expected] of cases) expect(normalizeBaseUrl(input), input).toBe(expected);
	});
});

describe('aiServiceInfo', () => {
	it('OpenAI のベース URL を替えてあれば、送り先の名前をそのホストにする', () => {
		expect(aiServiceInfo('openai').name()).toBe('OpenAI');
		expect(aiServiceInfo('openai', 'http://localhost:11434/v1').name()).toBe('localhost:11434');
		// ほかのサービスには関わらない
		expect(aiServiceInfo('gemini', 'http://localhost:11434/v1').name()).toBe('Gemini');
	});
});
