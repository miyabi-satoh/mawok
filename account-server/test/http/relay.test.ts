import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { costOf } from '../../src/ai';
import { pricing } from '../../src/pricing';
import { accountId, app, geminiAnswers, grantsOf, linkApp, sendAi } from '../helpers';

const { freeGrant: FREE_GRANT, rates } = pricing(env);

/** 同じアカウントの中継の印。 */
function inFlight(account: string) {
	return env.DB.prepare('SELECT owner FROM ai_in_flight WHERE account_id = ?')
		.bind(account)
		.first<{ owner: string }>();
}

describe('relaying to Gemini', () => {
	it('returns what Gemini answers, and charges what it reports', async () => {
		const email = 'relay@example.com';
		const { token } = await linkApp(email);
		const gemini = geminiAnswers();
		const res = await sendAi(token, { system: '丁寧に', user: 'こんにちは' });
		expect(res.status).toBe(200);
		// Gemini の返事をそのまま返す (Mawok が利用者のキーで送ったときと同じく読む)。
		expect(await res.json()).toMatchObject({ status: 'completed' });
		expect(JSON.parse(String(gemini.mock.calls[0][1]!.body))).toMatchObject({
			input: 'こんにちは',
			system_instruction: '丁寧に'
		});
		expect((await grantsOf(await accountId(email)))[0].remaining).toBe(
			FREE_GRANT - costOf({ total_input_tokens: 1000, total_output_tokens: 800 }, rates)!
		);
		expect(await inFlight(await accountId(email))).toBeNull();
	});

	it('releases only its own one-at-a-time mark', async () => {
		const email = 'own-mark@example.com';
		const { token } = await linkApp(email);
		const account = await accountId(email);
		// 前の中継の印が古くなり、この中継が取り直す。前の中継が後から外しても、この印は外れない。
		await env.DB.prepare(
			"INSERT INTO ai_in_flight (account_id, owner, started_at) VALUES (?, 'old', 0)"
		)
			.bind(account)
			.run();
		geminiAnswers();
		expect((await sendAi(token)).status).toBe(200);
		await env.DB.prepare("DELETE FROM ai_in_flight WHERE account_id = ? AND owner = 'old'")
			.bind(account)
			.run();
		expect(await inFlight(account)).toBeNull();
	});

	it('refuses without credit, without sending, and releases the one-at-a-time mark', async () => {
		const email = 'empty@example.com';
		const { token } = await linkApp(email);
		const account = await accountId(email);
		await env.DB.prepare('UPDATE grants SET remaining = 0 WHERE account_id = ?')
			.bind(account)
			.run();
		const gemini = geminiAnswers();
		const refused = await sendAi(token);
		expect(refused.status).toBe(402);
		expect(await refused.json()).toEqual({ error: 'no_credit' });
		expect(gemini).not.toHaveBeenCalled();
		expect(await inFlight(account)).toBeNull();
		expect(await (await app('/v1/balance', token)).json()).toMatchObject({ remaining_percent: 0 });
	});

	it('does not charge when Gemini cannot be reached, and charges failures Gemini reports', async () => {
		const email = 'unreachable@example.com';
		const { token } = await linkApp(email);
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
		expect((await sendAi(token)).status).toBe(500);
		expect((await grantsOf(await accountId(email)))[0].remaining).toBe(FREE_GRANT);
		vi.restoreAllMocks();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		geminiAnswers({ total_input_tokens: 1000, total_output_tokens: 0 }, 429);
		const failed = await sendAi(token);
		expect(failed.status).toBe(502);
		expect(await failed.json()).toEqual({ error: 'upstream', upstream_status: 429 });
		expect((await grantsOf(await accountId(email)))[0].remaining).toBe(
			FREE_GRANT - costOf({ total_input_tokens: 1000, total_output_tokens: 0 }, rates)!
		);
		// 失敗の後も、次の中継を受ける。
		vi.restoreAllMocks();
		geminiAnswers();
		expect((await sendAi(token)).status).toBe(200);
	});

	it('takes one request at a time per account', async () => {
		const email = 'busy@example.com';
		const { token } = await linkApp(email);
		const account = await accountId(email);
		await env.DB.prepare(
			"INSERT INTO ai_in_flight (account_id, owner, started_at) VALUES (?, 'other', ?)"
		)
			.bind(account, Math.floor(Date.now() / 1000))
			.run();
		const gemini = geminiAnswers();
		const busy = await sendAi(token);
		expect(busy.status).toBe(409);
		expect(await busy.json()).toEqual({ error: 'busy' });
		expect(gemini).not.toHaveBeenCalled();
		// Worker が途中で止まって残った印は、時間がたてば外れる。
		await env.DB.prepare('UPDATE ai_in_flight SET started_at = 0 WHERE account_id = ?')
			.bind(account)
			.run();
		expect((await sendAi(token)).status).toBe(200);
	});

	it('refuses malformed and too long requests without sending them', async () => {
		// どの形を断るかは test/ai.test.ts の parsePrompt で確かめる。
		const { token } = await linkApp('malformed@example.com');
		const gemini = geminiAnswers();
		const malformed = await sendAi(token, { text: 'x' });
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toEqual({ error: 'bad_request' });
		const tooLong = await sendAi(token, { user: 'x'.repeat(20_001) });
		expect(tooLong.status).toBe(413);
		expect(await tooLong.json()).toEqual({ error: 'too_long' });
		expect(gemini).not.toHaveBeenCalled();
	});
});
