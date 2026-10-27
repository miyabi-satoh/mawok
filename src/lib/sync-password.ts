import { CONSTANTS, ERROR_CODES } from '$lib/bindings/constants';
import type { SyncKeyStatus } from '$lib/bindings/SyncKeyStatus';
import { errorCode } from '$lib/errors';
import { m } from '$lib/paraglide/messages';

/** 同期のパスワードの最短の文字数。Rust 側（src-tauri/src/sync_key.rs）と同じ値 */
export const MIN_SYNC_PASSWORD_CHARS = CONSTANTS.MIN_SYNC_PASSWORD_CHARS;

/** 同期のパスワードの欄。エラーを、どの欄の下に出すかに使う */
type SyncPasswordField = 'current' | 'password' | 'confirm';
export type SyncPasswordErrors = Partial<Record<SyncPasswordField, string>>;

function tooShort(): string {
	return m.sync_password_error_too_short({ count: MIN_SYNC_PASSWORD_CHARS });
}

/**
 * 新しいパスワードを送る前の検査。短すぎるのを先に見る（確認の欄を合わせても通らないため）。
 * 文字数は Rust 側と同じく、コードポイントで数える
 */
export function newPasswordErrors(password: string, confirm: string): SyncPasswordErrors {
	if ([...password].length < MIN_SYNC_PASSWORD_CHARS) return { password: tooShort() };
	if (password !== confirm) return { confirm: m.sync_password_error_mismatch() };
	return {};
}

/**
 * Rust 側の失敗のうち、欄の下に出すもの（src-tauri/src/lib.rs の WRONG_SYNC_PASSWORD・SHORT_SYNC_PASSWORD）。
 * `checked` は、正しいかを確かめたパスワードの欄（変更では「現在のパスワード」）。ほかの失敗は undefined で、画面のエラーの帯に出す
 */
export function syncPasswordFailure(
	error: unknown,
	checked: 'current' | 'password'
): SyncPasswordErrors | undefined {
	const code = errorCode(error);
	if (code === ERROR_CODES.SYNC_WRONG_PASSWORD)
		return { [checked]: m.sync_password_error_incorrect() };
	if (code === ERROR_CODES.SYNC_PASSWORD_TOO_SHORT) return { password: tooShort() };
	return undefined;
}

/**
 * 窓口の同期の状態が、欄を出したときから変わっていた（ほかのデバイスが始めた・同期データを削除した・Pro が終わった）か
 * （src-tauri/src/error_codes.rs の SYNC_STATE_CHANGED）。Rust 側が鍵の状態を読み直してあるので、エラーは出さず、
 * 出している欄を閉じて、今の状態の欄に任せる
 */
export function syncStateChanged(error: unknown): boolean {
	return errorCode(error) === ERROR_CODES.SYNC_STATE_CHANGED;
}

/** 設定の「アカウント」の同期の所に出すもの（docs/sync.md「同期のパスワード」）。 */
export function syncPanel(status: SyncKeyStatus): 'create' | 'enter' | 'settings' {
	if (status === 'notStarted') return 'create';
	if (status === 'needsPassword') return 'enter';
	return 'settings';
}
