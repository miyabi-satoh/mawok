//! 画面に返すエラーの符号。画面は `cargo test` が書き出す `ERROR_CODES`（src/lib/bindings/constants.ts）から引く。

/// 一部の設定をバックアップから戻せなかった（OS がホットキーを登録できない など）
pub const BACKUP_RESTORE_PARTIAL: &str = "backup.restore_partial";
/// 設定のファイルが読めない（手で書きかけ・形が合わない）ので、画面からの変更を書けなかった。直すまでは書かない
pub const SETTINGS_FILE_UNREADABLE: &str = "settings.file_unreadable";
/// 選んだ置き場のフォルダーが無いので、設定を書けなかった。現れたら書ける
pub const SETTINGS_FOLDER_UNAVAILABLE: &str = "settings.folder_unavailable";
/// macOS のサンドボックスが設定のファイルの symlink の先を読ませないので、設定を書けなかった・置き場を替えなかった。
/// 許可されたら書ける
pub const SETTINGS_ACCESS_DENIED: &str = "settings.access_denied";
/// キーを割り当てられない理由（`draft_keys::Rejection::code`）
pub const KEYS_INVALID: &str = "keys.invalid";
pub const KEYS_EDITING: &str = "keys.editing";
pub const KEYS_HOTKEY: &str = "keys.hotkey";
/// ほかのアクションで使っているキー。後ろにそのアクションの画面での名前が付く
pub const KEYS_ACTION_PREFIX: &str = "keys.action.";
