import { errorCode } from '$lib/errors';
import { m } from '$lib/paraglide/messages';

/** 作業フォルダーへ移れなかったときに Rust 側が返す、理由の符号（src-tauri/src/folder.rs の FolderError::code） */
const MESSAGES: Record<string, () => string> = {
	'folder.not_found': m.folder_error_not_found,
	'folder.not_a_folder': m.folder_error_not_a_folder
};

/** 移れなかった理由を、欄の下に出す案内にする。符号でなければ、受け取った文字列をそのまま出す */
export function folderErrorMessage(error: unknown): string {
	const code = errorCode(error);
	return Object.hasOwn(MESSAGES, code) ? MESSAGES[code]() : code;
}
