import { invoke } from '@tauri-apps/api/core';

/** コマンドを呼んだ結果。返り値を持たないコマンドもあるので、成功したかは ok で見る */
type CallResult<T> = { ok: true; value: T } | { ok: false };

/**
 * コマンドを呼び、失敗したら画面に出す。成功したら出ていた失敗を消すが、keepError なら消さない
 * （失敗した操作の後の確かめ直しで、その失敗の知らせを消さないため）
 */
export type Call = <T>(
	command: string,
	args?: Record<string, unknown>,
	options?: { keepError?: boolean }
) => Promise<CallResult<T>>;

/**
 * Call を作る。失敗は describe で画面に出す文にして show に渡し、成功したら show に空文字を渡して消す
 */
export function commandCaller(
	describe: (error: unknown) => string,
	show: (message: string) => void
): Call {
	return async <T>(
		command: string,
		args?: Record<string, unknown>,
		options?: { keepError?: boolean }
	): Promise<CallResult<T>> => {
		try {
			const value = await invoke<T>(command, args);
			if (!options?.keepError) show('');
			return { ok: true, value };
		} catch (e) {
			show(describe(e));
			return { ok: false };
		}
	};
}
