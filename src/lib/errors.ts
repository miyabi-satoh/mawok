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

/**
 * Rust 側が返した失敗の符号。符号だけの文字列でも、`{ code, ... }` の形（送信やアクションの失敗）でも取り出す。
 * どちらでもなければ、受け取ったものをそのまま文字列にする
 */
export function errorCode(error: unknown): string {
	const code = typeof error === 'object' && error !== null && (error as { code?: unknown }).code;
	return typeof code === 'string' ? code : String(error);
}
