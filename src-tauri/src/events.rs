//! Rust と画面の間で送るイベント名。

pub const SETTINGS_CHANGED: &str = "settings-changed";
pub const DRAFT_HISTORY_CLEARED: &str = "draft-history-cleared";
/// 同期で履歴が替わった。テキストウィンドウは履歴を読み直す。
pub const DRAFT_HISTORY_SYNCED: &str = "draft-history-synced";
pub const SNIPPET_ADDED: &str = "snippet-added";
/// 同期かバックアップから戻したことで設定の行一覧が替わった。設定画面は行を新しい設定から写し直す。
pub const SYNC_APPLIED: &str = "sync-applied";
/// テキストウィンドウのエラーの帯から、AI の設定を頼まれた。設定画面は「AI」に移る。
pub const AI_SETTINGS_REQUESTED: &str = "ai-settings-requested";
pub const SHOWN: &str = "shown";
pub const HIDE_REQUESTED: &str = "hide-requested";
pub const DRAFT_HIDDEN: &str = "draft-hidden";
/// Mawok のアカウントのサインインが済んだか、期限が切れた（中身は MawokSignInEnded）
pub const MAWOK_SIGN_IN_ENDED: &str = "mawok-sign-in-ended";
/// Mac 版の更新の様子か、下書きの書きかけのあるなしが変わった（中身は UpdateView）
#[cfg(any(target_os = "macos", test))]
pub const UPDATE_CHANGED: &str = "update-changed";
