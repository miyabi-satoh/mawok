import { errorCode } from '$lib/errors';
import type { SendFailure } from '$lib/bindings/SendFailure';
import { m } from '$lib/paraglide/messages';

/**
 * 組み合わせと送信で Rust 側が返す、失敗の種類の符号（src-tauri/src/lan.rs の Failure::code）。
 * 詳しい中身は Rust 側でログに残し、画面には何をすればよいかの案内だけを出す
 */
const MESSAGES: Record<string, () => string> = {
	'lan.no_device': m.lan_error_no_device,
	'lan.no_target': m.lan_error_no_target,
	'lan.unreachable': m.lan_error_unreachable,
	'lan.refused': m.lan_error_refused,
	'lan.pro_required': m.lan_error_pro_required,
	'lan.receiver_pro_required': m.lan_error_receiver_pro_required,
	'lan.account_mismatch': m.lan_error_account_mismatch,
	'lan.too_long': m.lan_error_too_long,
	'lan.bad_code': m.lan_error_bad_code,
	'lan.wrong_code': m.lan_error_wrong_code,
	'lan.internal': m.lan_error_internal
};

/** 送信で、一部の機器にだけ届かなかったとき（Rust 側の SendFailure）。devices は届かなかった機器の公開鍵 */
export type PartialSend = SendFailure & { code: 'lan.partial' };

export function isPartialSend(error: unknown): error is PartialSend {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { code?: unknown }).code === 'lan.partial' &&
		Array.isArray((error as { devices?: unknown }).devices)
	);
}

/**
 * 組み合わせと送信のエラーを、画面に出す案内にする。符号でなければ、受け取った文字列をそのまま出す。
 * 送信のエラーは `{ code, devices }` の形で届くので、符号を取り出して同じように扱う
 */
export function lanErrorMessage(error: unknown): string {
	const code = errorCode(error);
	return Object.hasOwn(MESSAGES, code) ? MESSAGES[code]() : code;
}
