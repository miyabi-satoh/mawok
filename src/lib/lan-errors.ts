import { codeMessage, errorCode } from '$lib/errors';
import { m } from '$lib/paraglide/messages';

/**
 * ペアリングで Rust 側が返す、失敗の種類の符号（src-tauri/src/lan.rs の Failure::code）。
 * 詳しい中身は Rust 側でログに残し、画面には何をすればよいかの案内だけを出す
 */
const MESSAGES: Record<string, () => string> = {
	'lan.unreachable': m.lan_error_unreachable,
	'lan.needs_pairing': m.lan_error_needs_pairing,
	'lan.not_ready': m.lan_error_not_ready,
	'lan.key_mismatch': m.lan_error_key_mismatch,
	'lan.bad_code': m.lan_error_bad_code,
	'lan.wrong_code': m.lan_error_wrong_code,
	'lan.internal': m.lan_error_internal
};

/** ペアリングのエラーを、画面に出す案内にする。符号でなければ、受け取った文字列をそのまま出す */
export function lanErrorMessage(error: unknown): string {
	return codeMessage(MESSAGES, errorCode(error));
}
