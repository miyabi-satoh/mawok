import { errorCode } from '$lib/errors';
import type { ActionFailure } from '$lib/bindings/ActionFailure';
import { TEXT_MARK } from '$lib/action-target';
import { m } from '$lib/paraglide/messages';

/**
 * アクションで Rust 側が返す、失敗の種類の符号（src-tauri/src/actions.rs の Failure::code と、lib.rs の action.cancelled）。
 * 詳しい中身は Rust 側でログに残し、画面には何をすればよいかの案内だけを出す
 */
const MESSAGES: Record<string, () => string> = {
	'action.disabled': m.action_error_disabled,
	'action.no_key': m.action_error_no_key,
	'action.key_unreadable': m.action_error_key_unreadable,
	'action.invalid_key': m.action_error_invalid_key,
	'action.rejected': m.action_error_rejected,
	'action.model_not_found': m.action_error_model_not_found,
	'action.rate_limited': m.action_error_rate_limited,
	'action.billing': m.action_error_billing,
	'action.sign_in_required': m.action_error_sign_in_required,
	'action.no_credit': m.action_error_no_credit,
	'action.text_too_long': m.action_error_text_too_long,
	'action.previous_running': m.action_error_previous_running,
	// Mawok のアカウントの窓口につながらない（lib.rs の mawok_account_status）
	'account.unreachable': m.account_error_unreachable,
	'action.service_error': m.action_error_service_error,
	'action.network': m.action_error_network,
	'action.timeout': m.action_error_timeout,
	'action.command_not_started': m.action_error_command_not_started,
	'action.folder_missing': m.action_error_folder_missing,
	'action.text_not_embeddable': () => m.action_error_text_not_embeddable({ mark: TEXT_MARK }),
	'action.multiline_command': m.action_error_multiline_command,
	'action.empty_output': m.action_error_empty_output,
	'action.output_too_large': m.action_error_output_too_large,
	'action.text_not_encodable': m.action_error_text_not_encodable,
	'action.output_undecodable': m.action_error_output_undecodable,
	'action.unexpected': m.action_error_unexpected,
	'action.cancelled': m.action_error_cancelled
};

/**
 * アクションの失敗（Rust 側の ActionFailure）。detail は実行先自身の言葉で、AI は Rejected（設定のキーやモデル名の誤りなど、
 * 原因を決めつけない分類）のときだけ、あれば持つ。コマンドは失敗したときの標準エラーの末尾の数行
 */
function isActionFailure(error: unknown): error is ActionFailure {
	return (
		typeof error === 'object' &&
		error !== null &&
		typeof (error as { code?: unknown }).code === 'string'
	);
}

/** コマンドが 0 以外で終わったときの案内。終了コードがなければ、シグナルで止まった */
function commandFailedMessage(error: unknown): string {
	const code = isActionFailure(error) ? error.exitCode : null;
	return code === null ? m.action_error_command_killed() : m.action_error_command_failed({ code });
}

/**
 * アクションの失敗の符号なら、画面に出す案内にする。符号でなければ null（呼ぶ側が受け取った文字列をそのまま扱う）。
 * detail（利用者自身の下書きの断片を含みうるが、本人の画面に返すだけなので構わない）があれば添える。
 * コマンドの標準エラーは複数行になるので、案内の次の行から出す
 */
export function actionErrorMessage(error: unknown): string | null {
	const code = errorCode(error);
	if (code === 'action.command_failed' || code === 'action.command_not_found') {
		const message =
			code === 'action.command_failed'
				? commandFailedMessage(error)
				: m.action_error_command_not_found();
		const detail = isActionFailure(error) ? error.detail : null;
		return detail ? `${message}\n${detail}` : message;
	}
	if (!Object.hasOwn(MESSAGES, code)) return null;
	const message = MESSAGES[code]();
	const detail = isActionFailure(error) ? error.detail : null;
	return detail ? message + m.action_error_detail({ detail }) : message;
}
