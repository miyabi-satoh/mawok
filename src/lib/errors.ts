import { ERROR_CODES } from '$lib/bindings/constants';
import { m } from '$lib/paraglide/messages';

/** ログに残すために、エラーを1つの文字列にする。スタックトレースがあれば含める。 */
export function describeError(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	const head = `${error.name}: ${error.message}`;
	const stack = error.stack ?? '';
	// WebView2（V8）のスタックは先頭にエラー名とメッセージを含むが、WebKit のスタックは含まない
	if (stack.startsWith(head)) {
		return stack;
	}
	return stack ? `${head}\n${stack}` : head;
}

/** Rust 側が返した失敗の符号。コマンドは失敗を文字列で返す（符号か、符号の無い失敗はその文） */
export function errorCode(error: unknown): string {
	return String(error);
}

/**
 * 符号を、表（符号 → 文言）にある案内にする。表に無ければ、受け取った文字列をそのまま返す。
 * 表は Object.hasOwn で引く。`toString` のようなオブジェクトの持つ名前を、符号と取り違えないため
 */
export function codeMessage(messages: Record<string, () => string>, code: string): string {
	return Object.hasOwn(messages, code) ? messages[code]() : code;
}

/**
 * 設定を保存するコマンドが、置き場の設定のファイルを読めずに保存しなかったときの文。ほかの失敗なら undefined。
 * 手で書きかけのファイルを画面からの変更で消さないよう、Rust 側は読めないファイルを書き換えない
 */
export function settingsFileUnreadable(error: unknown): string | undefined {
	return errorCode(error) === ERROR_CODES.SETTINGS_FILE_UNREADABLE
		? m.settings_file_unreadable()
		: undefined;
}
