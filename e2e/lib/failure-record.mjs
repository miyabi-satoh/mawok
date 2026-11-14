// 落ちた時点の記録 (画面と窓の一覧) を置く手順のうち、OS に依らない所。撮り方と読み方は各 OS の captureFailure が持つ。
// 記録に失敗しても、テストの失敗の上にフックのエラーを重ねないよう、どれも投げずにログに出す

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * `dir` を作り、落ちたテスト `name` の記録のパスの元 (拡張子の前まで) を返す。作れなければログに出して null。
 * `tag` はログの頭の印 (`e2e`・`macos-check` など)
 */
export async function failureBase(dir, name, tag) {
	try {
		await fs.mkdir(dir, { recursive: true });
	} catch (error) {
		console.error(`[${tag}] 記録の置き場を作れませんでした: ${error.message}`);
		return null;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	return path.join(dir, `${stamp} ${name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80)}`);
}

/** 窓の一覧などの様子を `<base>.json` に書き、書いた先を返す */
export async function writeFailureState(base, state) {
	await fs.writeFile(`${base}.json`, `${JSON.stringify(state, null, '\t')}\n`);
	return `${base}.json`;
}

/**
 * 画面を `<base>.png` に撮り (`screenshot`)、様子 (`state`) を `<base>.json` に書いて、置けた先を返す。
 * どちらかに失敗しても、もう片方は残す
 *
 * @param {{ dir: string, name: string, tag: string, screenshot: (file: string) => Promise<unknown>, state: () => Promise<unknown> }} options
 */
export async function recordFailure({ dir, name, tag, screenshot, state }) {
	const base = await failureBase(dir, name, tag);
	if (base === null) return [];
	const saved = [];
	try {
		await screenshot(`${base}.png`);
		saved.push(`${base}.png`);
	} catch (error) {
		console.error(`[${tag}] 画面を撮れませんでした: ${error.message}`);
	}
	try {
		saved.push(await writeFailureState(base, await state()));
	} catch (error) {
		console.error(`[${tag}] 窓の一覧を読めませんでした: ${error.message}`);
	}
	return saved;
}
