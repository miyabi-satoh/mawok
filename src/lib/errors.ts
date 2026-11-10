import { ERROR_CODES } from '$lib/bindings/constants';
import type { SettingsProblem } from '$lib/bindings/SettingsProblem';
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
 * 設定を保存するコマンドが、置き場の都合で保存しなかったときの文。ほかの失敗なら undefined。
 * 読めない設定のファイルは、手で書きかけのものを画面からの変更で消さないよう書き換えない。選んだ置き場のフォルダーが
 * 無い間は、つながった後のファイルを既定の設定で上書きしないよう何も書かない
 */
export function settingsSaveProblem(error: unknown): string | undefined {
	switch (errorCode(error)) {
		case ERROR_CODES.SETTINGS_FILE_UNREADABLE:
			return m.settings_file_unreadable();
		case ERROR_CODES.SETTINGS_FOLDER_UNAVAILABLE:
			return m.settings_folder_unavailable();
		// macOS のサンドボックスが symlink の先を読ませない間も、symlink を普通のファイルに置き換えないよう何も書かない
		case ERROR_CODES.SETTINGS_ACCESS_DENIED:
			return m.settings_access_denied();
		default:
			return undefined;
	}
}

/** 設定の保存先を替えられなかったときの文。置き場の都合でなければ、符号を添えた失敗の文にする */
export function settingsFolderProblem(error: unknown): string {
	const code = errorCode(error);
	switch (code) {
		case ERROR_CODES.SETTINGS_FILE_UNREADABLE:
			return m.settings_folder_unreadable();
		case ERROR_CODES.SETTINGS_FOLDER_UNAVAILABLE:
			return m.settings_folder_link_missing();
		case ERROR_CODES.SETTINGS_ACCESS_DENIED:
			return m.settings_folder_access_denied();
		default:
			return m.settings_failed({ error: code });
	}
}

/**
 * 「設定の保存先」に出す、設定の保存先の今の問題の知らせ。見つからないのが行に出している保存先そのものなら、
 * パスを繰り返さない。symlink の先が無いときだけ、そのパスを出す
 */
export function settingsProblemNotice(problem: SettingsProblem, settingsDir: string): string {
	switch (problem.kind) {
		case 'unreadable':
			return m.settings_file_unreadable_notice({ files: problem.files.join(', ') });
		case 'folderMissing':
			return problem.path === settingsDir
				? m.settings_folder_dir_missing()
				: m.settings_folder_missing({ path: problem.path });
		case 'accessNeeded':
			return m.settings_folder_access_needed({ path: problem.path });
	}
}
