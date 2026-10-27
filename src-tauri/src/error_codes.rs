//! 画面に返すエラーの符号。画面は `cargo test` が書き出す `ERROR_CODES`（src/lib/bindings/constants.ts）から引く。
//! アクションの失敗の符号は `actions::Failure::code` が持つ

/// Mawok のアカウントの窓口につながらない
pub const ACCOUNT_UNREACHABLE: &str = "account.unreachable";
/// アクションを打ち切った
pub const ACTION_CANCELLED: &str = "action.cancelled";
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
