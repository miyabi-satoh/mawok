/**
 * 作者のキーで Gemini へ中継する (→ docs/account-server.md「中継」)。
 * モデル・出力の上限・入力の上限はここで決め打ちし、Mawok からは変えさせない (生の API の代わりにさせないため。Google APIs Terms 4.a)。
 * 送った文も結果もログに残さない。
 */

import type { Rates } from './pricing';

/** Interactions API (ai.google.dev/api/interactions-api)。Mawok が利用者のキーで送るときと同じ口。 */
const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1/interactions';

/** 中継するモデル。Mawok が利用者のキーで使うときの既定と同じ。 */
const MODEL = 'gemini-3.5-flash-lite';

/** 返事の長さの上限。書き直した文は元の文と同じくらいの長さなので、入力の上限に見合うだけ取る。 */
const MAX_OUTPUT_TOKENS = 16_000;
/** 受ける文の長さ (指示文と文の合計、UTF-16 の単位)。下書きの書き直しに足り、長い文書の一括の処理には使わせない。 */
const MAX_INPUT_CHARS = 20_000;
/** 返事を待つ上限。Mawok の待つ時間 (60 秒) より短くし、Mawok が先に諦めて、使った分だけ引かれることを避ける。 */
const TIMEOUT_MS = 50_000;

/** Mawok が組み立てて送る中身 (Mawok の `ai::Prompt` と同じ形)。 */
export type Prompt = { system?: string; user: string };

/** 受けた本文を `Prompt` として読む。形が違うか、長すぎるときは `undefined`。 */
export function parsePrompt(body: unknown): Prompt | 'too_long' | undefined {
	if (typeof body !== 'object' || body === null) return undefined;
	const { system, user } = body as Record<string, unknown>;
	if (typeof user !== 'string' || (system !== undefined && typeof system !== 'string')) {
		return undefined;
	}
	if (user.length + (system?.length ?? 0) > MAX_INPUT_CHARS) return 'too_long';
	return system === undefined ? { user } : { system, user };
}

/** Gemini の返事。`body` は Mawok へそのまま返す。`cost` は使った原価 (milli_yen)。 */
export type Relayed =
	| { ok: true; body: string; cost: number }
	| { ok: false; status: number; body: string; cost: number };

/**
 * 返事の `usage` から原価 (milli_yen、切り上げ) を出す。
 * `usage` が無いか読めなければ `undefined` (返事の形が崩れている)。
 */
export function costOf(usage: unknown, rates: Rates): number | undefined {
	if (typeof usage !== 'object' || usage === null) return undefined;
	const u = usage as Record<string, unknown>;
	const valid = (key: string) =>
		typeof u[key] === 'number' && Number.isFinite(u[key]) && (u[key] as number) >= 0;
	// 入力と出力の数が読めなければ、使った量が分からない。思考のトークンは、使わなければ無いことがある。
	if (!valid('total_input_tokens') || !valid('total_output_tokens')) return undefined;
	const count = (key: string) => (valid(key) ? (u[key] as number) : 0);
	const usd =
		(count('total_input_tokens') * rates.inputUsdPerMtok +
			(count('total_output_tokens') + count('total_thought_tokens')) * rates.outputUsdPerMtok) /
		1_000_000;
	return Math.ceil(usd * rates.usdJpy * 1000);
}

/** Gemini へ送る。届かなかったときは投げる (引かない)。 */
export async function relay(env: Env, prompt: Prompt, rates: Rates): Promise<Relayed> {
	const request: Record<string, unknown> = {
		model: MODEL,
		input: prompt.user,
		// やり取りを Google 側に保存させない (止めても、不正利用の監視のための保持は規約どおり残る)。
		store: false,
		generation_config: { max_output_tokens: MAX_OUTPUT_TOKENS }
	};
	if (prompt.system !== undefined) request.system_instruction = prompt.system;
	const res = await fetch(GEMINI_INTERACTIONS_URL, {
		method: 'POST',
		headers: { 'x-goog-api-key': env.GEMINI_API_KEY ?? '', 'content-type': 'application/json' },
		body: JSON.stringify(request),
		signal: AbortSignal.timeout(TIMEOUT_MS)
	});
	const body = await res.text();
	let usage: unknown;
	try {
		usage = (JSON.parse(body) as { usage?: unknown }).usage;
	} catch {
		usage = undefined;
	}
	let cost = costOf(usage, rates);
	// 成功したのに使った量が分からなければ、無料にせず、入力の全部と出力の上限を使ったものとして引く。
	if (cost === undefined && res.ok) {
		console.error('Gemini responded without usage');
		cost = costOf(
			{
				total_input_tokens: prompt.user.length + (prompt.system?.length ?? 0),
				total_output_tokens: MAX_OUTPUT_TOKENS
			},
			rates
		);
	}
	cost ??= 0;
	if (res.ok) return { ok: true, body, cost };
	// 中身を含みうるので本文は残さず、状態だけを残す。
	console.error('Gemini responded', res.status);
	return { ok: false, status: res.status, body, cost };
}
