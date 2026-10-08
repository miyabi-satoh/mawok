import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { costOf, parsePrompt, relay } from '../src/ai';
import { pricing } from '../src/pricing';
import { geminiAnswers } from './helpers';

describe('parsePrompt', () => {
	it('reads the prompt Mawok builds, and refuses other shapes', () => {
		expect(parsePrompt({ system: 's', user: 'u' })).toEqual({ system: 's', user: 'u' });
		expect(parsePrompt({ user: 'u' })).toEqual({ user: 'u' });
		for (const body of [
			undefined,
			null,
			'u',
			{ text: 'x' },
			{ user: 1 },
			{ user: 'x', system: 1 }
		]) {
			expect(parsePrompt(body), JSON.stringify(body)).toBeUndefined();
		}
	});

	it('takes up to 20,000 characters of instruction and text together', () => {
		expect(parsePrompt({ user: 'x'.repeat(20_000) })).toEqual({ user: 'x'.repeat(20_000) });
		expect(parsePrompt({ user: 'x'.repeat(20_001) })).toBe('too_long');
		expect(parsePrompt({ system: 'x'.repeat(10_000), user: 'x'.repeat(10_001) })).toBe('too_long');
	});
});

describe('costOf', () => {
	// 本番とは違う、決まりを確かめるための値。
	const rates = { usdJpy: 100, inputUsdPerMtok: 1, outputUsdPerMtok: 4 };

	it('charges thinking tokens as output, rounding up', () => {
		// 入力 1,000・出力 800 トークンで、0.0042 ドル。1 ドル 100 円で 0.42 円。
		expect(costOf({ total_input_tokens: 1000, total_output_tokens: 800 }, rates)).toBe(420);
		expect(costOf({ total_input_tokens: 1, total_output_tokens: 0 }, rates)).toBe(1);
		expect(
			costOf({ total_input_tokens: 0, total_output_tokens: 100, total_thought_tokens: 100 }, rates)
		).toBe(80);
	});

	it('treats a broken usage as unknown', () => {
		for (const usage of [
			undefined,
			{},
			{ total_input_tokens: '10', total_output_tokens: 5 },
			{ total_input_tokens: 10, total_output_tokens: -1 }
		]) {
			expect(costOf(usage, rates), JSON.stringify(usage)).toBeUndefined();
		}
	});
});

describe('relay', () => {
	const { rates } = pricing(env);

	it('sends with the fixed model and limits, without storing', async () => {
		const gemini = geminiAnswers();
		const result = await relay(env, { system: '丁寧に', user: 'こんにちは' }, rates);
		expect(result).toMatchObject({
			ok: true,
			cost: costOf({ total_input_tokens: 1000, total_output_tokens: 800 }, rates)
		});
		const [url, init] = gemini.mock.calls[0];
		expect(url).toBe('https://generativelanguage.googleapis.com/v1/interactions');
		expect(new Headers(init!.headers).get('x-goog-api-key')).toBe('dummy');
		expect(JSON.parse(String(init!.body))).toEqual({
			model: 'gemini-3.5-flash-lite',
			input: 'こんにちは',
			system_instruction: '丁寧に',
			store: false,
			generation_config: { max_output_tokens: 16000 }
		});
		await relay(env, { user: 'こんにちは' }, rates);
		expect(JSON.parse(String(gemini.mock.calls[1][1]!.body))).not.toHaveProperty(
			'system_instruction'
		);
	});

	it('charges as if the most was used when Gemini does not say how much', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			Response.json({ status: 'completed', steps: [] })
		);
		const result = await relay(env, { user: 'abc' }, rates);
		expect(result.cost).toBe(costOf({ total_input_tokens: 3, total_output_tokens: 16_000 }, rates));
	});

	it('charges what Gemini reports on a failure, and nothing when it does not say', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		geminiAnswers({ total_input_tokens: 1000, total_output_tokens: 0 }, 429);
		expect(await relay(env, { user: 'abc' }, rates)).toMatchObject({
			ok: false,
			status: 429,
			cost: costOf({ total_input_tokens: 1000, total_output_tokens: 0 }, rates)
		});
		vi.restoreAllMocks();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async () => new Response('Service Unavailable', { status: 503 })
		);
		expect(await relay(env, { user: 'abc' }, rates)).toMatchObject({
			ok: false,
			status: 503,
			cost: 0
		});
	});

	it('throws when Gemini cannot be reached', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
		await expect(relay(env, { user: 'abc' }, rates)).rejects.toThrow('network down');
	});
});
