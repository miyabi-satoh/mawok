//! 画面に返すエラーの符号。画面は `cargo test` が書き出す `ERROR_CODES`（src/lib/bindings/constants.ts）から引く。

/// Mawok のアカウントの窓口につながらない
pub const ACCOUNT_UNREACHABLE: &str = "account.unreachable";
/// Mawok のアカウントにサインインしていないか、トークンが外された
pub const ACCOUNT_SIGN_IN_REQUIRED: &str = "account.sign_in_required";
/// Mawok のアカウントのトークンを資格情報管理から読めない（キーチェーンの許可を拒んだなど）
pub const ACCOUNT_TOKEN_UNREADABLE: &str = "account.token_unreadable";
/// ほかのどれにも当たらない（窓口の答えが読めない、包んだ鍵が見分けと合わない など）。詳しい中身はログに残す
pub const UNEXPECTED: &str = "unexpected";
/// 一部の設定をバックアップから戻せなかった（OS がホットキーを登録できない など）
pub const BACKUP_RESTORE_PARTIAL: &str = "backup.restore_partial";
/// 同期のパスワードで、窓口の包んだ鍵を開けなかった
pub const SYNC_WRONG_PASSWORD: &str = "sync.wrong_password";
/// 同期のパスワードが短すぎる
pub const SYNC_PASSWORD_TOO_SHORT: &str = "sync.password_too_short";
/// 窓口の同期の状態が、画面を出したときから変わっていた（ほかのデバイスが始めた・同期データを削除した・Pro が終わった）。
/// 鍵の状態は読み直してあるので、画面はエラーを出さずに、今の状態の欄へ移る
pub const SYNC_STATE_CHANGED: &str = "sync.state_changed";
/// キーを割り当てられない理由（`draft_keys::Rejection::code`）
pub const KEYS_INVALID: &str = "keys.invalid";
pub const KEYS_EDITING: &str = "keys.editing";
pub const KEYS_HOTKEY: &str = "keys.hotkey";
/// ほかのアクションで使っているキー。後ろにそのアクションの画面での名前が付く
pub const KEYS_ACTION_PREFIX: &str = "keys.action.";
