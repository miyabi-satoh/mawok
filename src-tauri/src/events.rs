//! Rust と画面の間で送るイベント名。

pub const SETTINGS_CHANGED: &str = "settings-changed";
pub const DRAFT_HISTORY_CLEARED: &str = "draft-history-cleared";
/// ほかのデバイスの履歴を混ぜて、履歴が替わった。テキストウィンドウは履歴を読み直す。
pub const DRAFT_HISTORY_MERGED: &str = "draft-history-merged";
pub const SNIPPET_ADDED: &str = "snippet-added";
/// 設定のファイルがほかで変わったか、置き場を替えたか、バックアップから戻したことで、設定が替わった。設定画面は、持っている写し（行・打って直す欄）を今の設定から写し直す。
pub const CONFIG_REPLACED: &str = "config-replaced";
/// トレイの ⚠ の項目で、設定画面に出す分類を頼んだ。設定画面は take_settings_category で受け取る。
pub const SETTINGS_CATEGORY_REQUESTED: &str = "settings-category-requested";
/// 下書きを出した。中身は `Shown`（`clear_text`: 入力欄を空から始めるか）。
pub const SHOWN: &str = "shown";
pub const HIDE_REQUESTED: &str = "hide-requested";
