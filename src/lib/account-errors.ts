import { codeMessage, errorCode } from '$lib/errors';
import { ERROR_CODES } from '$lib/bindings/constants';
import { m } from '$lib/paraglide/messages';

/**
 * Mawok のアカウントの窓口を使うコマンドで Rust 側が返す符号の案内（符号は src-tauri/src/error_codes.rs）。
 * 詳しい中身は Rust 側でログに残し、画面には何をすればよいかの案内だけを出す
 */
const MESSAGES: Record<string, () => string> = {
	[ERROR_CODES.ACCOUNT_UNREACHABLE]: m.account_error_unreachable,
	[ERROR_CODES.ACCOUNT_SIGN_IN_REQUIRED]: m.account_error_sign_in_required,
	[ERROR_CODES.ACCOUNT_TOKEN_UNREADABLE]: m.account_error_token_unreadable,
	[ERROR_CODES.UNEXPECTED]: m.account_error_unexpected
};

/** アカウントの符号なら、画面に出す案内にする。符号でなければ null（呼ぶ側が受け取った文字列をそのまま扱う） */
export function accountErrorMessage(error: unknown): string | null {
	const code = errorCode(error);
	return Object.hasOwn(MESSAGES, code) ? codeMessage(MESSAGES, code) : null;
}
